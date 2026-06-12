# dynamodb — the 9 HousingChoice tables.
#
# ============================================================================
# SOURCE OF TRUTH: app/src/lib/tables.ts (repo root). The `tables` input
# variable is GENERATED from the TABLES export there: `npm run gen:tables`
# writes infra/envs/{dev,prod}/tables.auto.tfvars.json (auto-loaded by
# terraform), and this module for_eaches over it. `npm run plan`/`drift` fail
# when the generated JSON is stale, so the two can never disagree. Never
# hand-edit the JSON — change tables.ts, run `npm run gen:tables`, commit both.
# ============================================================================
#
# Conventions applied to ALL tables (architecture doc §5):
#   - billing PAY_PER_REQUEST (on-demand)
#   - deletion protection ENABLED
#   - every GSI projects ALL (document-style items; index-only reads)
#   - stream view type, when enabled, is always NEW_AND_OLD_IMAGES
#   - physical name = "${var.name_prefix}${baseName}" (hc-dev-contacts, ...)

locals {
  # Distinct key attributes per table (table keys + all GSI keys).
  table_attributes = {
    for base, t in var.tables : base => distinct(concat(
      [t.hash_key],
      t.range_key != null ? [t.range_key] : [],
      flatten([
        for g in t.gsis : concat(
          [g.hash_key],
          g.range_key != null ? [g.range_key] : [],
        )
      ]),
    ))
  }
}

resource "aws_dynamodb_table" "this" {
  for_each = var.tables

  name                        = "${var.name_prefix}${each.key}"
  billing_mode                = "PAY_PER_REQUEST"
  deletion_protection_enabled = true

  hash_key  = each.value.hash_key.name
  range_key = each.value.range_key != null ? each.value.range_key.name : null

  dynamic "attribute" {
    for_each = local.table_attributes[each.key]
    content {
      name = attribute.value.name
      type = attribute.value.type
    }
  }

  dynamic "global_secondary_index" {
    for_each = each.value.gsis
    content {
      name            = global_secondary_index.value.index_name
      projection_type = "ALL"

      # key_schema replaces the GSI-level hash_key/range_key arguments
      # (deprecated in AWS provider v6.5x). HASH first, RANGE second.
      key_schema {
        attribute_name = global_secondary_index.value.hash_key.name
        key_type       = "HASH"
      }
      dynamic "key_schema" {
        for_each = global_secondary_index.value.range_key != null ? [global_secondary_index.value.range_key.name] : []
        content {
          attribute_name = key_schema.value
          key_type       = "RANGE"
        }
      }
    }
  }

  stream_enabled   = each.value.stream
  stream_view_type = each.value.stream ? "NEW_AND_OLD_IMAGES" : null

  dynamic "ttl" {
    for_each = each.value.ttl_attribute != null ? [each.value.ttl_attribute] : []
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }

  point_in_time_recovery {
    enabled = each.value.pitr
  }
}
