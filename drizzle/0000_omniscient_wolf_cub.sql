CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"phone" varchar(30),
	"role" varchar(50) DEFAULT 'operator',
	"organization_id" uuid,
	"permissions" jsonb DEFAULT '[]'::jsonb,
	"preferences" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"device_id" varchar(255),
	"device_name" varchar(255),
	"device_type" varchar(50),
	"ip_address" varchar(64),
	"user_agent" text,
	"location" varchar(255),
	"revoked" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "measurements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	"parameter" varchar(255) NOT NULL,
	"value" double precision,
	"unit" varchar(50) DEFAULT '',
	"topic" text DEFAULT '',
	"simulated" boolean DEFAULT false,
	"quality" integer DEFAULT 100,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid,
	"tag_id" uuid,
	"organization_id" uuid,
	"severity" varchar(20),
	"message" text,
	"value" double precision,
	"threshold" double precision,
	"resolved" boolean DEFAULT false,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_note" text,
	"acknowledged" boolean DEFAULT false,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_note" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"device_type" varchar(100),
	"protocol" varchar(50) DEFAULT 'mqtt',
	"topic_pattern" varchar(255),
	"ip_address" varchar(64),
	"port" integer,
	"credentials" jsonb,
	"config" jsonb,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"description" text,
	"unit" varchar(50),
	"data_type" varchar(20) DEFAULT 'float',
	"address" varchar(255),
	"scale_factor" double precision DEFAULT 1,
	"offset" double precision DEFAULT 0,
	"min_value" double precision,
	"max_value" double precision,
	"is_critical" boolean DEFAULT false,
	"group" varchar(100),
	"order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"action" varchar(100),
	"resource" varchar(100),
	"resource_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb,
	"ip_address" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"plant_name" varchar(255),
	"operator_id" varchar(100),
	"production_target" double precision,
	"recovery_target" double precision,
	"filter_dp_warn" double precision,
	"filter_dp_crit" double precision,
	"low_recovery_warn" double precision,
	"low_chem_alert" double precision,
	"min_dosing" double precision,
	"max_dosing" double precision,
	"updated_at" timestamp with time zone DEFAULT now(),
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"tag_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"condition_type" varchar(50),
	"condition_config" jsonb,
	"severity" varchar(20) DEFAULT 'warning',
	"priority" integer DEFAULT 1,
	"cooldown_minutes" integer DEFAULT 5,
	"escalation_minutes" integer DEFAULT 15,
	"actions" jsonb DEFAULT '[]'::jsonb,
	"created_by" uuid,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "billing_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"paystack_plan_code" varchar(100),
	"amount_kes" double precision DEFAULT 0 NOT NULL,
	"interval" varchar(20) DEFAULT 'monthly' NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "billing_plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_code" varchar(50) NOT NULL,
	"paystack_customer_code" varchar(100),
	"paystack_subscription_code" varchar(100),
	"paystack_email_token" varchar(100),
	"status" varchar(20) DEFAULT 'inactive' NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "billing_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_code" varchar(50) NOT NULL,
	"plan_name" varchar(100) NOT NULL,
	"amount_kes" double precision NOT NULL,
	"paystack_reference" varchar(100),
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"purchase_date" timestamp with time zone DEFAULT now(),
	"period_end" timestamp with time zone,
	CONSTRAINT "billing_history_paystack_reference_unique" UNIQUE("paystack_reference")
);
--> statement-breakpoint
CREATE INDEX "measurements_parameter_time_idx" ON "measurements" USING btree ("parameter","time");--> statement-breakpoint
CREATE INDEX "measurements_time_idx" ON "measurements" USING btree ("time");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_user_idx" ON "billing_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "billing_history_user_date_idx" ON "billing_history" USING btree ("user_id","purchase_date");