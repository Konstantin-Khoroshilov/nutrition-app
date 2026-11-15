
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const databaseFolder = path.join(__dirname, 'database');

if (!fs.existsSync(databaseFolder)) {
  fs.mkdirSync(databaseFolder, { recursive: true });
}

const db = new DatabaseSync(
  path.join(databaseFolder, 'nutrition.db')
);

db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS menus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    recognized_at TEXT
  );
`);

const menuColumns = db.prepare('PRAGMA table_info(menus)').all();

if (!menuColumns.some(column => column.name === 'recognized_at')) {
  db.exec('ALTER TABLE menus ADD COLUMN recognized_at TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_dishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    portion_weight_g REAL,
    calories REAL,
    protein REAL,
    fat REAL,
    carbs REAL,
    nutrition_status TEXT NOT NULL,
    missing_fields TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE
  );
`);

// Текущие цели пользователя
db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    calories REAL NOT NULL,
    protein REAL NOT NULL,
    fat REAL NOT NULL,
    carbs REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Цели, сохранённые для конкретного дня
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_goals (
    diary_date TEXT PRIMARY KEY,
    calories REAL NOT NULL,
    protein REAL NOT NULL,
    fat REAL NOT NULL,
    carbs REAL NOT NULL
  );
`);

// Записи дневника питания
db.exec(`
  CREATE TABLE IF NOT EXISTS diary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    diary_date TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    dish_name TEXT NOT NULL,
    portion_weight_g REAL NOT NULL,
    calories REAL,
    protein REAL,
    fat REAL,
    carbs REAL,
    missing_fields TEXT,
    nutrition_status TEXT NOT NULL DEFAULT 'complete',
    created_at TEXT NOT NULL
  );
`);

module.exports = db;
