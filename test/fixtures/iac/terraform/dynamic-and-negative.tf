# This comment must not create a resource:
# resource "aws_db_instance" "commented" { publicly_accessible = true }

module "network" {
  source = "./network"
}

data "aws_vpc" "selected" {
  id = var.vpc_id
}

resource "aws_db_instance" "dynamic" {
  name                = "dynamic-db"
  publicly_accessible = var.database_public
  count               = var.enabled ? 1 : 0
}

resource "null_resource" "lookalike" {
  triggers = local.values
}
