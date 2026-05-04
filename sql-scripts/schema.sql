-- ============================================================
-- TempShare+ | Azure SQL Database Schema
-- COM682 CW2 | Run in Azure Portal Query Editor
-- ============================================================

-- ── ROLES TABLE ──────────────────────────────────────────
CREATE TABLE Roles (
    role_id       INT           IDENTITY(1,1) PRIMARY KEY,
    role_name     NVARCHAR(50)  NOT NULL UNIQUE,  -- 'admin', 'user'
    max_file_mb   INT           NOT NULL DEFAULT 50,
    max_expiry_h  INT           NOT NULL DEFAULT 168,
    can_delete_others BIT       NOT NULL DEFAULT 0,
    created_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

-- ── USERS TABLE ───────────────────────────────────────────
CREATE TABLE Users (
    user_id       NVARCHAR(128) PRIMARY KEY,       -- matches ownerID in Cosmos DB
    email         NVARCHAR(255) NOT NULL UNIQUE,
    display_name  NVARCHAR(100),
    password_hash NVARCHAR(500),                   -- bcrypt hash
    role_id       INT           NOT NULL DEFAULT 2 -- 2 = 'user'
                  REFERENCES Roles(role_id),
    is_active     BIT           NOT NULL DEFAULT 1,
    created_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

-- ── SHARES TABLE (SQL cross-reference to Cosmos DB) ────
CREATE TABLE Shares (
    share_id        NVARCHAR(128) PRIMARY KEY,    -- matches Cosmos DB document id
    user_id         NVARCHAR(128) NOT NULL REFERENCES Users(user_id),
    share_token     NVARCHAR(256) NOT NULL UNIQUE,
    cosmos_meta_id  NVARCHAR(128),                -- Cosmos DB doc id
    expires_at      DATETIME2     NOT NULL,
    status          NVARCHAR(20)  NOT NULL DEFAULT 'active',  -- active | expired
    created_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

-- ── AUDIT LOG TABLE ───────────────────────────────────────
CREATE TABLE AuditLog (
    log_id          INT           IDENTITY(1,1) PRIMARY KEY,
    user_id         NVARCHAR(128) REFERENCES Users(user_id),
    asset_id        NVARCHAR(128),
    action_type     NVARCHAR(50)  NOT NULL,  -- UPLOAD | DOWNLOAD | DELETE | EXPIRE
    ip_address      NVARCHAR(45),
    action_timestamp DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME()
);

-- ── SEED DATA ─────────────────────────────────────────────
INSERT INTO Roles (role_name, max_file_mb, max_expiry_h, can_delete_others)
VALUES
  ('admin', 500, 8760, 1),
  ('user',  50,  168,  0);

INSERT INTO Users (user_id, email, display_name, role_id)
VALUES
  ('user_demo_001', 'demo@tempshare.dev', 'Demo User', 2);

-- ── USEFUL QUERIES FOR VIDEO DEMO ────────────────────────
-- Show all active shares:
-- SELECT s.share_id, u.email, s.expires_at, s.status
-- FROM Shares s JOIN Users u ON s.user_id = u.user_id
-- WHERE s.status = 'active';

-- Show audit trail:
-- SELECT * FROM AuditLog ORDER BY action_timestamp DESC;
