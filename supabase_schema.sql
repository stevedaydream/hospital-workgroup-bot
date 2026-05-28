-- 1. 同仁資料表 (Users)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    line_user_id TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL
);

-- 2. 公告注意事項表 (General Notes)
CREATE TABLE IF NOT EXISTS general_notes (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by TEXT NOT NULL
);

-- 3. 醫師群組對照表 (Doctor Group Mapping)
CREATE TABLE IF NOT EXISTS doctor_group_mapping (
    id SERIAL PRIMARY KEY,
    match_key TEXT NOT NULL,
    group_name TEXT NOT NULL,
    line_group_id TEXT NOT NULL,
    type TEXT NOT NULL -- 'DIRECT' 或 'FLEXIBLE'
);

-- 4. 每日分流快取表 (Daily Dispatch Cache)
CREATE TABLE IF NOT EXISTS daily_dispatch_cache (
    id SERIAL PRIMARY KEY,
    target_line_group_id TEXT NOT NULL,
    source_image_message_id TEXT NOT NULL,
    is_confirmed BOOLEAN NOT NULL,
    created_at DATE NOT NULL DEFAULT CURRENT_DATE
);

-- 5. 行事曆行程活動表 (Group Events)
CREATE TABLE IF NOT EXISTS group_events (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    date DATE NOT NULL,
    time TEXT,
    location TEXT,
    description TEXT,
    source_group_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by TEXT NOT NULL
);

-- 6. 輪序設定表 (Presentation Rotations)
CREATE TABLE IF NOT EXISTS presentation_rotations (
    id SERIAL PRIMARY KEY,
    doctors JSONB DEFAULT '[]'::jsonb,
    nps JSONB DEFAULT '[]'::jsonb,
    exclusions JSONB DEFAULT '[]'::jsonb,
    dept_sequence JSONB DEFAULT '[]'::jsonb,
    ward_sequence JSONB DEFAULT '[]'::jsonb,
    source_group_id TEXT UNIQUE NOT NULL
);
