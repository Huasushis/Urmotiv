ALTER TABLE installed_plugins ADD COLUMN project_url text;
--> statement-breakpoint
ALTER TABLE installed_plugins ADD CONSTRAINT installed_plugins_project_url_length_ck CHECK (project_url IS NULL OR length(project_url) <= 2048);
