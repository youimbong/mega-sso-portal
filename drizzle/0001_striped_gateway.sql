CREATE TABLE "hr_employee" (
	"code" varchar(10) PRIMARY KEY NOT NULL,
	"korean_name" text NOT NULL,
	"department_code" varchar(10),
	"department_name" text,
	"business_place_code" varchar(10),
	"business_place_name" text,
	"job_type_name" text,
	"payroll_email" text,
	"employment_status" varchar(3) DEFAULT 'J01' NOT NULL,
	"resignation_date" date,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
