ALTER TABLE "billing_plans" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "billing_plans" CASCADE;--> statement-breakpoint
ALTER TABLE "billing_history" DROP CONSTRAINT "billing_history_paystack_reference_unique";--> statement-breakpoint
DROP INDEX "billing_subscriptions_user_idx";--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "plan_code" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "billing_history" ALTER COLUMN "plan_code" SET DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "billing_history" ALTER COLUMN "plan_name" SET DEFAULT 'AguaWatch Subscription';--> statement-breakpoint
ALTER TABLE "billing_history" ALTER COLUMN "amount_kes" SET DEFAULT 25000;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "mpesa_phone" varchar(20);--> statement-breakpoint
ALTER TABLE "billing_history" ADD COLUMN "mpesa_checkout_request_id" varchar(100);--> statement-breakpoint
ALTER TABLE "billing_history" ADD COLUMN "mpesa_merchant_request_id" varchar(100);--> statement-breakpoint
ALTER TABLE "billing_history" ADD COLUMN "mpesa_receipt_number" varchar(50);--> statement-breakpoint
ALTER TABLE "billing_history" ADD COLUMN "mpesa_phone" varchar(20);--> statement-breakpoint
CREATE INDEX "billing_subscriptions_user_status_idx" ON "billing_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "billing_history_checkout_request_idx" ON "billing_history" USING btree ("mpesa_checkout_request_id");--> statement-breakpoint
ALTER TABLE "billing_subscriptions" DROP COLUMN "paystack_customer_code";--> statement-breakpoint
ALTER TABLE "billing_subscriptions" DROP COLUMN "paystack_subscription_code";--> statement-breakpoint
ALTER TABLE "billing_subscriptions" DROP COLUMN "paystack_email_token";--> statement-breakpoint
ALTER TABLE "billing_history" DROP COLUMN "paystack_reference";--> statement-breakpoint
ALTER TABLE "billing_history" ADD CONSTRAINT "billing_history_mpesa_checkout_request_id_unique" UNIQUE("mpesa_checkout_request_id");