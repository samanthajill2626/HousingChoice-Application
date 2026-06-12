# network — default-VPC-free networking for one stack.
#
# Lean by decision (architecture doc): ONE public subnet, no NAT, no private
# tier. The single EC2 instance lives in the public subnet behind a security
# group that only admits CloudFront origin-facing traffic on the app port.
# No SSH ingress anywhere — operator access is SSM Session Manager only.

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}vpc"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}igw"
  }
}

# map_public_ip_on_launch: the instance gets an ephemeral public IP at boot so
# cloud-init (dnf install docker, compose download) has egress immediately,
# even before the stable EIP association lands a moment later.
resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name_prefix}public-${var.availability_zone}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# AWS-managed prefix list of CloudFront origin-facing ranges: only CloudFront
# edge locations can reach the app port. Combined with the x-origin-verify
# header (validated in app middleware), this is the full origin lockdown.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "app" {
  name        = "${var.name_prefix}app"
  description = "App instance: CloudFront-only ingress on ${var.app_port}, no SSH (SSM only)"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}app"
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_cloudfront" {
  security_group_id = aws_security_group.app.id
  description       = "App port from CloudFront origin-facing ranges only"
  ip_protocol       = "tcp"
  from_port         = var.app_port
  to_port           = var.app_port
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
}

# Egress all: SSM agent, ECR pulls, DynamoDB, Parameter Store, CloudWatch, dnf.
resource "aws_vpc_security_group_egress_rule" "all_ipv4" {
  security_group_id = aws_security_group.app.id
  description       = "All egress (IPv4)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "all_ipv6" {
  security_group_id = aws_security_group.app.id
  description       = "All egress (IPv6)"
  ip_protocol       = "-1"
  cidr_ipv6         = "::/0"
}
