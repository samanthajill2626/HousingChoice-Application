output "origin_secret" {
  description = "The CF_ORIGIN_SECRET value — consumed by the cloudfront module as the x-origin-verify custom header."
  value       = random_password.cf_origin_secret.result
  sensitive   = true
}

output "param_path_prefix" {
  description = "Parameter Store path prefix M0.5's deploy hydrates .env from."
  value       = "/hc/${var.env}/app"
}
