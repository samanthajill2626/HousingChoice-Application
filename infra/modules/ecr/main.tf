# ecr — one repository per stack for the single ARM64 app image (app + worker
# run from the same image via compose). M0.5's deploy pushes here.

resource "aws_ecr_repository" "app" {
  name = "${var.name_prefix}app"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keep only the most recent images; old deploy images expire automatically.
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep only the last ${var.keep_image_count} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.keep_image_count
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
