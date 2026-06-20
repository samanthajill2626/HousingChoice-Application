output "table_arns" {
  description = "Map of base table name -> table ARN (all 9 tables)."
  value       = { for base, t in aws_dynamodb_table.this : base => t.arn }
}

output "table_names" {
  description = "Map of base table name -> physical table name."
  value       = { for base, t in aws_dynamodb_table.this : base => t.name }
}

output "stream_arns" {
  description = "Map of base table name -> stream ARN for stream-enabled tables (messages, placements)."
  value = {
    for base, t in aws_dynamodb_table.this : base => t.stream_arn
    if var.tables[base].stream
  }
}
