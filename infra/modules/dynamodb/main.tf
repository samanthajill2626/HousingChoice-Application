# dynamodb — the 9 HousingChoice tables.
#
# ============================================================================
# SOURCE OF TRUTH: app/src/lib/tables.ts (repo root). This local list is a
# 1:1 MIRROR of the TABLES export there — same base names, key schemas, GSI
# names + key attributes, stream settings (messages, cases) and the matches
# TTL. If this file and tables.ts ever disagree, tables.ts WINS and this file
# is wrong. Any change is a contract change: update BOTH places in the same
# change and log it in the README "Deviations" table.
# ============================================================================
#
# Conventions applied to ALL tables (architecture doc §5):
#   - billing PAY_PER_REQUEST (on-demand)
#   - point-in-time recovery ENABLED
#   - deletion protection ENABLED
#   - every GSI projects ALL (document-style items; index-only reads)
#   - physical name = "${var.name_prefix}${baseName}" (hc-dev-contacts, ...)

locals {
  # range_key / gsi range_key use { name = "", type = "" } sentinels (HCL needs
  # uniform object shapes in collections); empty name means "no range key".
  tables = {
    contacts = {
      hash_key  = { name = "contactId", type = "S" }
      range_key = { name = "", type = "" }
      gsis = [
        {
          name      = "byPhone"
          hash_key  = { name = "phone", type = "S" }
          range_key = { name = "", type = "" }
        },
        {
          name      = "byTypeStatus"
          hash_key  = { name = "type", type = "S" }
          range_key = { name = "status", type = "S" }
        },
        {
          name      = "byHousingAuthority"
          hash_key  = { name = "housing_authority", type = "S" }
          range_key = { name = "", type = "" }
        },
      ]
      stream        = false
      ttl_attribute = ""
    }
    units = {
      hash_key  = { name = "unitId", type = "S" }
      range_key = { name = "", type = "" }
      gsis = [
        {
          name      = "byLandlord"
          hash_key  = { name = "landlordId", type = "S" }
          range_key = { name = "", type = "" }
        },
        {
          name      = "byStatus"
          hash_key  = { name = "status", type = "S" }
          range_key = { name = "", type = "" }
        },
        {
          name      = "byJurisdiction"
          hash_key  = { name = "jurisdiction", type = "S" }
          range_key = { name = "", type = "" }
        },
      ]
      stream        = false
      ttl_attribute = ""
    }
    conversations = {
      hash_key  = { name = "conversationId", type = "S" }
      range_key = { name = "", type = "" }
      gsis = [
        {
          name      = "byParticipantPhone"
          hash_key  = { name = "participant_phone", type = "S" }
          range_key = { name = "", type = "" }
        },
        {
          name      = "byLastActivity"
          hash_key  = { name = "status", type = "S" }
          range_key = { name = "last_activity_at", type = "S" }
        },
      ]
      stream        = false
      ttl_attribute = ""
    }
    messages = {
      hash_key  = { name = "conversationId", type = "S" }
      range_key = { name = "tsMsgId", type = "S" }
      gsis      = []
      # Feeds side effects (doc §5).
      stream        = true
      ttl_attribute = ""
    }
    matches = {
      hash_key  = { name = "tenantId", type = "S" }
      range_key = { name = "unitId", type = "S" }
      gsis = [
        {
          name      = "byUnit"
          hash_key  = { name = "unitId", type = "S" }
          range_key = { name = "tenantId", type = "S" }
        },
      ]
      stream = false
      # Volatile engine output; stale rows TTL away (epoch seconds).
      ttl_attribute = "expires_at"
    }
    cases = {
      hash_key  = { name = "caseId", type = "S" }
      range_key = { name = "", type = "" }
      gsis = [
        {
          name      = "byTenant"
          hash_key  = { name = "tenantId", type = "S" }
          range_key = { name = "", type = "" }
        },
        {
          name      = "byUnit"
          hash_key  = { name = "unitId", type = "S" }
          range_key = { name = "", type = "" }
        },
        {
          name      = "byStage"
          hash_key  = { name = "stage", type = "S" }
          range_key = { name = "", type = "" }
        },
        # Sparse by data convention (tables.ts): key attrs simply absent.
        {
          name      = "byTourDate"
          hash_key  = { name = "tour_date", type = "S" }
          range_key = { name = "", type = "" }
        },
        {
          name      = "byNextDeadline"
          hash_key  = { name = "next_deadline_type", type = "S" }
          range_key = { name = "next_deadline_at", type = "S" }
        },
      ]
      # Stage transitions feed side effects (doc §5).
      stream        = true
      ttl_attribute = ""
    }
    invoices = {
      hash_key  = { name = "invoiceId", type = "S" }
      range_key = { name = "", type = "" }
      gsis = [
        {
          name      = "byLandlord"
          hash_key  = { name = "landlordId", type = "S" }
          range_key = { name = "", type = "" }
        },
        {
          name      = "byStatus"
          hash_key  = { name = "status", type = "S" }
          range_key = { name = "", type = "" }
        },
      ]
      stream        = false
      ttl_attribute = ""
    }
    users = {
      hash_key  = { name = "userId", type = "S" }
      range_key = { name = "", type = "" }
      gsis = [
        {
          name      = "byEmail"
          hash_key  = { name = "email", type = "S" }
          range_key = { name = "", type = "" }
        },
      ]
      stream        = false
      ttl_attribute = ""
    }
    audit_events = {
      hash_key  = { name = "entityKey", type = "S" }
      range_key = { name = "ts", type = "S" }
      gsis = [
        {
          name      = "byActor"
          hash_key  = { name = "actorId", type = "S" }
          range_key = { name = "ts", type = "S" }
        },
      ]
      stream        = false
      ttl_attribute = ""
    }
  }

  # Distinct key attributes per table (table keys + all GSI keys).
  table_attributes = {
    for base, t in local.tables : base => distinct(concat(
      [t.hash_key],
      t.range_key.name != "" ? [t.range_key] : [],
      flatten([
        for g in t.gsis : concat(
          [g.hash_key],
          g.range_key.name != "" ? [g.range_key] : [],
        )
      ]),
    ))
  }
}

resource "aws_dynamodb_table" "this" {
  for_each = local.tables

  name                        = "${var.name_prefix}${each.key}"
  billing_mode                = "PAY_PER_REQUEST"
  deletion_protection_enabled = true

  hash_key  = each.value.hash_key.name
  range_key = each.value.range_key.name != "" ? each.value.range_key.name : null

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
      name            = global_secondary_index.value.name
      projection_type = "ALL"

      # key_schema replaces the GSI-level hash_key/range_key arguments
      # (deprecated in AWS provider v6.5x). HASH first, RANGE second.
      key_schema {
        attribute_name = global_secondary_index.value.hash_key.name
        key_type       = "HASH"
      }
      dynamic "key_schema" {
        for_each = global_secondary_index.value.range_key.name != "" ? [global_secondary_index.value.range_key.name] : []
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
    for_each = each.value.ttl_attribute != "" ? [each.value.ttl_attribute] : []
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }

  point_in_time_recovery {
    enabled = true
  }
}
