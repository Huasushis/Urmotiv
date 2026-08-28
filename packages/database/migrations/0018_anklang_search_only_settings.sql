UPDATE "plugin_settings"
SET "settings" = "settings" - 'blockWhenRecommended'
WHERE "plugin_id" = 'org.ustc.urmotiv.anklang'
  AND "settings" ? 'blockWhenRecommended';
