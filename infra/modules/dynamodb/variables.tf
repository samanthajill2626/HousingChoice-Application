variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-); physical table name = prefix + baseName."
  type        = string
}

variable "tables" {
  description = <<-EOT
    Map of base table name -> table definition. GENERATED — the env roots load
    this from tables.auto.tfvars.json, written by `npm run gen:tables` from
    app/src/lib/tables.ts (the contractual source of truth). Never hand-edit
    the JSON. Map KEYS are the for_each keys and therefore the state addresses
    (module.dynamodb.aws_dynamodb_table.this["<key>"]) — renaming a key moves
    the resource.
  EOT
  type = map(object({
    hash_key  = object({ name = string, type = string })
    range_key = optional(object({ name = string, type = string }))
    gsis = list(object({
      index_name = string
      hash_key   = object({ name = string, type = string })
      range_key  = optional(object({ name = string, type = string }))
    }))
    stream        = bool
    ttl_attribute = optional(string)
    pitr          = bool
  }))
}
