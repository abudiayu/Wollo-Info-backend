-- ============================================================
-- Content Manager Migration
-- Run once: mysql -u root -p wollo-info-hub < Db/content_migration.sql
-- BACK UP FIRST: mysqldump -u root -p wollo-info-hub > backup_before_content.sql
-- ============================================================

-- media folders (before media, which references it)
CREATE TABLE IF NOT EXISTS media_folders (
  id         INT          NOT NULL AUTO_INCREMENT,
  name       VARCHAR(200) NOT NULL,
  parent_id  INT              NULL DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mf_parent (parent_id),
  CONSTRAINT fk_mf_parent FOREIGN KEY (parent_id)
    REFERENCES media_folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- uploaded files / images
CREATE TABLE IF NOT EXISTS media (
  id            INT          NOT NULL AUTO_INCREMENT,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(255) NOT NULL,
  mime_type     VARCHAR(120) NOT NULL,
  size          INT          NOT NULL DEFAULT 0,
  type          ENUM('image','file','folder-asset') NOT NULL DEFAULT 'file',
  folder_id     INT              NULL DEFAULT NULL,
  url           VARCHAR(512) NOT NULL,
  uploaded_by   INT          NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_media_folder  (folder_id),
  KEY idx_media_uploader(uploaded_by),
  CONSTRAINT fk_media_folder   FOREIGN KEY (folder_id)   REFERENCES media_folders(id) ON DELETE SET NULL,
  CONSTRAINT fk_media_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id)          ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- public-facing sections (motivation, opportunity, department)
CREATE TABLE IF NOT EXISTS sections (
  id          INT          NOT NULL AUTO_INCREMENT,
  slug        VARCHAR(60)  NOT NULL,
  title       VARCHAR(200) NOT NULL,
  description TEXT             NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sections_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- seed the three sections (safe to re-run)
INSERT IGNORE INTO sections (slug, title, description, sort_order) VALUES
  ('motivation',  'Motivation',   'Motivational stories and advice for students.', 1),
  ('opportunity', 'Opportunities','Clubs, programs and activities at Wollo University.', 2),
  ('department',  'Departments',  'Academic departments and faculties.', 3);

-- content items
CREATE TABLE IF NOT EXISTS content_items (
  id             INT          NOT NULL AUTO_INCREMENT,
  section_id     INT          NOT NULL,
  title          VARCHAR(255) NOT NULL,
  body           LONGTEXT         NULL,
  status         ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  cover_media_id INT              NULL DEFAULT NULL,
  sort_order     INT          NOT NULL DEFAULT 0,
  created_by     INT          NOT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  published_at   DATETIME         NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_ci_section (section_id),
  KEY idx_ci_status  (status),
  KEY idx_ci_creator (created_by),
  CONSTRAINT fk_ci_section FOREIGN KEY (section_id)     REFERENCES sections(id)    ON DELETE RESTRICT,
  CONSTRAINT fk_ci_cover   FOREIGN KEY (cover_media_id) REFERENCES media(id)       ON DELETE SET NULL,
  CONSTRAINT fk_ci_creator FOREIGN KEY (created_by)     REFERENCES users(id)       ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- many-to-many: content ↔ media (gallery)
CREATE TABLE IF NOT EXISTS content_media (
  content_id INT NOT NULL,
  media_id   INT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (content_id, media_id),
  KEY idx_cm_media (media_id),
  CONSTRAINT fk_cm_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_cm_media   FOREIGN KEY (media_id)   REFERENCES media(id)          ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- version history
CREATE TABLE IF NOT EXISTS content_versions (
  id         INT      NOT NULL AUTO_INCREMENT,
  content_id INT      NOT NULL,
  title      VARCHAR(255) NOT NULL,
  body       LONGTEXT     NULL,
  edited_by  INT      NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cv_content  (content_id),
  KEY idx_cv_editor   (edited_by),
  CONSTRAINT fk_cv_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_cv_editor  FOREIGN KEY (edited_by)  REFERENCES users(id)          ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
