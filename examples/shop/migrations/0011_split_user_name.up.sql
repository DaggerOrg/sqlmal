ALTER TABLE users ADD COLUMN first_name text;
ALTER TABLE users ADD COLUMN last_name text;

UPDATE users
SET first_name = split_part(name, ' ', 1),
    last_name  = NULLIF(trim(substr(name, length(split_part(name, ' ', 1)) + 1)), '')
WHERE name IS NOT NULL;
