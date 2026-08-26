resource "aws_db_instance" "orders" {
  name                    = "orders-db"
  publicly_accessible     = true
  archsync_trust_boundary = "data"
}

resource "aws_elasticache_replication_group" "orders_cache" {
  name                    = "orders-cache"
  publicly_accessible     = false
  archsync_approved       = true
  archsync_trust_boundary = "data"
}

resource "aws_mq_broker" "events" {
  name                    = "orders-events"
  publicly_accessible     = false
  archsync_trust_boundary = "integration"
}

resource "aws_lb" "edge" {
  name                    = "public-edge"
  scheme                  = "internet-facing"
  archsync_trust_boundary = "public"
}

resource "google_sql_database_instance" "audit" {
  name         = "audit-db"
  ipv4_enabled = false
}
