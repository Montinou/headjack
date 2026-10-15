DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skillvault_app') THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'headjack_app') THEN
      RAISE EXCEPTION 'both skillvault_app and headjack_app exist: resolve by hand before migrating';
    END IF;
    ALTER ROLE skillvault_app RENAME TO headjack_app;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'headjack_app') THEN
    RAISE EXCEPTION 'neither skillvault_app nor headjack_app exists';
  END IF;
END $$;
