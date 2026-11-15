
const express = require('express');
const path = require('path');
const db = require('./database/database');
const fs = require('fs');
const { recognizeMenuBuffer } = require('./recognize');
const { downloadImage, MAX_IMAGE_BYTES } = require('./imageDownloader');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '14mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const mealTypes = ['breakfast', 'lunch', 'snack', 'dinner'];

function isValidDate(date) {
  return typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function getOrCreateDailyGoals(date) {
  const currentGoals = db.prepare(
    'SELECT * FROM goals WHERE id = 1'
  ).get();

  if (!currentGoals) {
    return null;
  }

  db.prepare(`
    INSERT INTO daily_goals
    (diary_date, calories, protein, fat, carbs)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(diary_date) DO UPDATE SET
      calories = excluded.calories,
      protein = excluded.protein,
      fat = excluded.fat,
      carbs = excluded.carbs
  `).run(
    date,
    currentGoals.calories,
    currentGoals.protein,
    currentGoals.fat,
    currentGoals.carbs
  );

  return db.prepare(
    'SELECT * FROM daily_goals WHERE diary_date = ?'
  ).get(date);
}

// Проверка работы сервера
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Сервер работает'
  });
});


function getMenuDishes(menuId) {
  return db.prepare(`
    SELECT id, menu_id, name, portion_weight_g, calories, protein, fat, carbs,
      nutrition_status, missing_fields
    FROM menu_dishes
    WHERE menu_id = ?
    ORDER BY id
  `).all(menuId).map(dish => ({
    ...dish,
    missing_fields: JSON.parse(dish.missing_fields)
  }));
}

function getMenu(menuId) {
  const menu = db.prepare(
    'SELECT id, name, source, created_at, recognized_at FROM menus WHERE id = ?'
  ).get(menuId);

  if (!menu) {
    return null;
  }

  return {
    ...menu,
    dishes: getMenuDishes(menuId)
  };
}

function insertMenu(name, source, dishes = [], recognizedAt = null) {
  db.exec('BEGIN');

  try {
    const result = db.prepare(`
      INSERT INTO menus (name, source, created_at, recognized_at)
      VALUES (?, ?, ?, ?)
    `).run(name, source, new Date().toISOString(), recognizedAt);
    const menuId = Number(result.lastInsertRowid);

    insertMenuDishes(menuId, dishes);

    db.exec('COMMIT');
    return menuId;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function insertMenuDishes(menuId, dishes) {
  const insertDish = db.prepare(`
    INSERT INTO menu_dishes (
      menu_id, name, portion_weight_g, calories, protein, fat, carbs,
      nutrition_status, missing_fields
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const dish of dishes) {
    insertDish.run(
      menuId,
      dish.name,
      dish.portion_weight_g,
      dish.calories,
      dish.protein,
      dish.fat,
      dish.carbs,
      dish.nutrition_status,
      JSON.stringify(dish.missing_fields || [])
    );
  }
}

function saveRecognizedMenu(name, source, dishes, recognizedAt) {
  const existingMenu = db.prepare(
    'SELECT id FROM menus WHERE source = ? ORDER BY id DESC LIMIT 1'
  ).get(source);

  if (!existingMenu) {
    return insertMenu(name, source, dishes, recognizedAt);
  }

  db.exec('BEGIN');

  try {
    db.prepare(`
      UPDATE menus
      SET name = ?, created_at = ?, recognized_at = ?
      WHERE id = ?
    `).run(name, new Date().toISOString(), recognizedAt, existingMenu.id);
    db.prepare('DELETE FROM menu_dishes WHERE menu_id = ?')
      .run(existingMenu.id);
    insertMenuDishes(existingMenu.id, dishes);
    db.exec('COMMIT');
    return existingMenu.id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seedDefaultMenu() {
  const menuCount = db.prepare('SELECT COUNT(*) AS count FROM menus').get().count;

  if (menuCount > 0) {
    return;
  }

  const menuPath = path.join(__dirname, 'menu-calculated.json');

  if (!fs.existsSync(menuPath)) {
    return;
  }

  const data = JSON.parse(fs.readFileSync(menuPath, 'utf8'));

  if (!Array.isArray(data.dishes)) {
    throw new Error('В menu-calculated.json отсутствует массив dishes');
  }

  const dishes = data.dishes.map(dish => {
    const portion = dish.nutrition_per_portion || {};

    return {
      name: dish.name,
      portion_weight_g: dish.portion_weight_g ?? portion.weight_g ?? null,
      calories: portion.calories ?? null,
      protein: portion.protein ?? null,
      fat: portion.fat ?? null,
      carbs: portion.carbs ?? null,
      nutrition_status: dish.nutrition_status || 'unknown',
      missing_fields: dish.missing_fields || []
    };
  });

  insertMenu('Сохранённое меню', 'saved', dishes, data.recognized_at || null);
}

function validateMenuName(name) {
  return typeof name === 'string' && name.trim().length > 0 &&
    name.trim().length <= 100;
}

function decodeImageData(imageData) {
  const match = typeof imageData === 'string' &&
    imageData.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);

  if (!match) {
    throw new Error('Загрузите изображение в формате JPEG, PNG или WebP');
  }

  const buffer = Buffer.from(match[1], 'base64');

  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Размер изображения должен быть не более 10 МБ');
  }

  return buffer;
}

function prepareRecognizedDish(dish) {
  const weight = typeof dish.portion_weight_g === 'number' &&
    Number.isFinite(dish.portion_weight_g) &&
    dish.portion_weight_g > 0
    ? dish.portion_weight_g
    : null;

  const sourceValues = {
    calories: dish.calories_per_100g,
    protein: dish.protein_per_100g,
    fat: dish.fat_per_100g,
    carbs: dish.carbs_per_100g
  };
  const missingFields = [];
  const portionValues = {};

  if (weight === null) {
    missingFields.push('portion_weight_g');
  }

  for (const [field, value] of Object.entries(sourceValues)) {
    if (weight === null || value === null || value === undefined) {
      portionValues[field] = null;
      missingFields.push(field);
    } else {
      portionValues[field] = Math.round(
        value * weight / 100 * 10
      ) / 10;
    }
  }

  return {
    name: dish.name,
    portion_weight_g: weight,
    ...portionValues,
    nutrition_status: missingFields.length > 0 ? 'approximate' : 'menu',
    missing_fields: missingFields
  };
}

app.get('/api/menus', (req, res) => {
  const menus = db.prepare(`
    SELECT menu.id, menu.name, menu.source, menu.created_at,
      menu.recognized_at, COUNT(menu_dishes.id) AS dish_count
    FROM menus AS menu
    LEFT JOIN menu_dishes ON menu_dishes.menu_id = menu.id
    WHERE menu.id = (
      SELECT MAX(latest.id)
      FROM menus AS latest
      WHERE latest.source = menu.source
    )
    GROUP BY menu.id
    ORDER BY menu.id DESC
  `).all();

  res.json(menus);
});

app.get('/api/menus/:id', (req, res) => {
  const menuId = Number(req.params.id);

  if (!Number.isInteger(menuId) || menuId <= 0) {
    return res.status(400).json({ error: 'Некорректный ID меню' });
  }

  const menu = getMenu(menuId);

  if (!menu) {
    return res.status(404).json({ error: 'Меню не найдено' });
  }

  res.json(menu);
});

app.delete('/api/menus/source/:source', (req, res) => {
  const { source } = req.params;
  const allowedSources = ['image_url', 'image_upload', 'manual'];

  if (!allowedSources.includes(source)) {
    return res.status(400).json({ error: 'Некорректный источник меню' });
  }

  const menuCount = db.prepare(
    'SELECT COUNT(*) AS count FROM menus WHERE source = ?'
  ).get(source).count;

  if (menuCount === 0) {
    return res.status(404).json({ error: 'Меню не найдено' });
  }

  const dishCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM menu_dishes
    WHERE menu_id IN (SELECT id FROM menus WHERE source = ?)
  `).get(source).count;

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM menus WHERE source = ?').run(source);

    if (source === 'manual') {
      db.prepare(`
        INSERT INTO menus (name, source, created_at)
        VALUES (?, ?, ?)
      `).run('Моё меню', 'manual', new Date().toISOString());
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  res.json({
    success: true,
    deleted_menus: menuCount,
    deleted_dishes: dishCount
  });
});

app.post('/api/menus/recognize', async (req, res) => {
  const { name, url, imageData } = req.body;

  if (!validateMenuName(name)) {
    return res.status(400).json({
      error: 'Укажите название меню (не более 100 символов)'
    });
  }

  if (Boolean(url) === Boolean(imageData)) {
    return res.status(400).json({
      error: 'Укажите ссылку или выберите изображение'
    });
  }

  let image;
  let source;
  let processingStage;

  try {
    if (url) {
      if (typeof url !== 'string' || url.length > 2048) {
        return res.status(400).json({ error: 'Некорректная ссылка на изображение' });
      }

      source = 'image_url';
      processingStage = 'download';
      const downloaded = await downloadImage(url);
      image = downloaded.buffer;
    } else {
      source = 'image_upload';
      processingStage = 'decode';
      image = decodeImageData(imageData);
    }

    processingStage = 'recognition';
    const recognized = await recognizeMenuBuffer(image);
    const dishes = recognized.dishes.map(prepareRecognizedDish);

    if (dishes.length === 0) {
      return res.status(422).json({
        error: 'Не удалось распознать блюда на изображении'
      });
    }

    const menuId = saveRecognizedMenu(
      name.trim(),
      source,
      dishes,
      recognized.recognized_at
    );
    res.status(201).json(getMenu(menuId));
  } catch (error) {
    console.error('Ошибка обработки изображения меню:', error);
    const status = error.statusCode ||
      (processingStage === 'download'
        ? 422
        : processingStage === 'decode'
          ? 400
          : 500);

    res.status(status).json({
      error: error.message || 'Не удалось распознать меню'
    });
  }
});

app.post('/api/menus/manual', (req, res) => {
  const existingMenu = db.prepare(
    'SELECT id FROM menus WHERE source = ? ORDER BY id DESC LIMIT 1'
  ).get('manual');

  if (existingMenu) {
    return res.json(getMenu(existingMenu.id));
  }

  const menuId = insertMenu('Моё меню', 'manual');
  res.status(201).json(getMenu(menuId));
});

app.post('/api/menus/:id/dishes', (req, res) => {
  const menuId = Number(req.params.id);

  if (!Number.isInteger(menuId) || menuId <= 0) {
    return res.status(400).json({ error: 'Некорректный ID меню' });
  }

  const menu = db.prepare(
    'SELECT source FROM menus WHERE id = ?'
  ).get(menuId);

  if (!menu) {
    return res.status(404).json({ error: 'Меню не найдено' });
  }

  if (menu.source !== 'manual') {
    return res.status(400).json({
      error: 'Вручную добавлять блюда можно только в собственное меню'
    });
  }

  const { name, portion_weight_g, calories, protein, fat, carbs } = req.body;
  const numericValues = {
    'вес порции': portion_weight_g,
    'калорийность': calories,
    'белки': protein,
    'жиры': fat,
    'углеводы': carbs
  };

  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200) {
    return res.status(400).json({
      error: 'Укажите название блюда (не более 200 символов)'
    });
  }

  if (
    typeof portion_weight_g !== 'number' ||
    !Number.isFinite(portion_weight_g) ||
    portion_weight_g <= 0
  ) {
    return res.status(400).json({ error: 'Вес порции должен быть больше нуля' });
  }

  for (const [label, value] of Object.entries(numericValues)) {
    if (
      label !== 'вес порции' &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      return res.status(400).json({
        error: `Укажите корректное значение показателя «${label}»`
      });
    }
  }

  db.prepare(`
    INSERT INTO menu_dishes (
      menu_id, name, portion_weight_g, calories, protein, fat, carbs,
      nutrition_status, missing_fields
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', '[]')
  `).run(
    menuId,
    name.trim(),
    portion_weight_g,
    calories,
    protein,
    fat,
    carbs
  );

  res.status(201).json(getMenu(menuId));
});

app.delete('/api/menus/:menuId/dishes/:dishId', (req, res) => {
  const menuId = Number(req.params.menuId);
  const dishId = Number(req.params.dishId);

  if (
    !Number.isInteger(menuId) ||
    menuId <= 0 ||
    !Number.isInteger(dishId) ||
    dishId <= 0
  ) {
    return res.status(400).json({ error: 'Некорректный ID меню или блюда' });
  }

  const menu = db.prepare(
    'SELECT source FROM menus WHERE id = ?'
  ).get(menuId);

  if (!menu) {
    return res.status(404).json({ error: 'Меню не найдено' });
  }

  if (menu.source !== 'manual') {
    return res.status(400).json({
      error: 'Удалять блюда можно только из «Моего меню»'
    });
  }

  const result = db.prepare(`
    DELETE FROM menu_dishes
    WHERE id = ? AND menu_id = ?
  `).run(dishId, menuId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Блюдо не найдено' });
  }

  res.json({ success: true });
});

app.get('/api/menu', (req, res) => {
  const firstMenu = db.prepare(
    'SELECT id FROM menus ORDER BY id DESC LIMIT 1'
  ).get();

  if (!firstMenu) {
    return res.status(404).json({ error: 'Меню не найдено' });
  }

  const menu = getMenu(firstMenu.id);

  res.json({
    source: menu.name,
    total_dishes: menu.dishes.length,
    dishes: menu.dishes
  });
});

// Получение текущих целей
app.get('/api/goals', (req, res) => {
  const goals = db.prepare(
    'SELECT * FROM goals WHERE id = 1'
  ).get();

  res.json(goals || null);
});

// Сохранение текущих целей
app.put('/api/goals', (req, res) => {
  const { diary_date, calories, protein, fat, carbs } = req.body;

  const values = [calories, protein, fat, carbs];

  const valid = values.every(value =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
  );

  if (!valid) {
    return res.status(400).json({
      error: 'Все цели должны быть положительными числами'
    });
  }

  if (diary_date !== undefined && !isValidDate(diary_date)) {
    return res.status(400).json({
      error: 'Некорректная дата'
    });
  }

  db.prepare(`
    INSERT INTO goals (id, calories, protein, fat, carbs, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      calories = excluded.calories,
      protein = excluded.protein,
      fat = excluded.fat,
      carbs = excluded.carbs,
      updated_at = excluded.updated_at
  `).run(
    calories,
    protein,
    fat,
    carbs,
    new Date().toISOString()
  );

  if (diary_date) {
    db.prepare(`
      INSERT INTO daily_goals (diary_date, calories, protein, fat, carbs)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(diary_date) DO UPDATE SET
        calories = excluded.calories,
        protein = excluded.protein,
        fat = excluded.fat,
        carbs = excluded.carbs
    `).run(diary_date, calories, protein, fat, carbs);
  }

  res.json({
    success: true,
    goals: db.prepare(
      'SELECT * FROM goals WHERE id = 1'
    ).get()
  });
});

// Получение дневника за выбранную дату
app.get('/api/diary', (req, res) => {
  const date = req.query.date;

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: 'Укажите дату в формате YYYY-MM-DD'
    });
  }

  const goals = getOrCreateDailyGoals(date);

  const entries = db.prepare(`
    SELECT * FROM diary_entries
    WHERE diary_date = ?
    ORDER BY id
  `).all(date).map(entry => ({
    ...entry,
    missing_fields: entry.missing_fields
      ? JSON.parse(entry.missing_fields)
      : []
  }));

  const nutrients = ['calories', 'protein', 'fat', 'carbs'];

  const totals = {};

  for (const nutrient of nutrients) {
    totals[nutrient] = entries.reduce((sum, entry) => {
      const value = entry[nutrient];
      return value === null ? sum : sum + value;
    }, 0);
  }

  const approximate = entries.some(entry =>
    entry.nutrition_status === 'approximate' ||
    nutrients.some(nutrient => entry[nutrient] === null)
  );

  res.json({
    date,
    goals,
    entries,
    totals,
    approximate
  });
});

// Добавление блюда в дневник
app.post('/api/diary/entries', (req, res) => {
  const {
    diary_date,
    meal_type,
    dish_name,
    portion_weight_g,
    calories,
    protein,
    fat,
    carbs,
    missing_fields = []
  } = req.body;

  if (!isValidDate(diary_date)) {
    return res.status(400).json({
      error: 'Некорректная дата'
    });
  }

  if (!mealTypes.includes(meal_type)) {
    return res.status(400).json({
      error: 'Некорректный приём пищи'
    });
  }

  if (
    typeof dish_name !== 'string' ||
    !dish_name.trim() ||
    typeof portion_weight_g !== 'number' ||
    !Number.isFinite(portion_weight_g) ||
    portion_weight_g <= 0
  ) {
    return res.status(400).json({
      error: 'Проверьте название блюда и вес порции'
    });
  }

  const nutrients = { calories, protein, fat, carbs };

  for (const [name, value] of Object.entries(nutrients)) {
    if (
      value !== null &&
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      return res.status(400).json({
        error: `Некорректное значение: ${name}`
      });
    }
  }

  if (
    !Array.isArray(missing_fields) ||
    !missing_fields.every(field => typeof field === 'string')
  ) {
    return res.status(400).json({
      error: 'Некорректный список недостающих показателей'
    });
  }

  const hasMissingData =
    missing_fields.length > 0 ||
    Object.values(nutrients).some(value => value == null);

  const result = db.prepare(`
    INSERT INTO diary_entries (
      diary_date, meal_type, dish_name, portion_weight_g,
      calories, protein, fat, carbs, missing_fields,
      nutrition_status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    diary_date,
    meal_type,
    dish_name.trim(),
    portion_weight_g,
    calories ?? null,
    protein ?? null,
    fat ?? null,
    carbs ?? null,
    JSON.stringify(missing_fields),
    hasMissingData ? 'approximate' : 'complete',
    new Date().toISOString()
  );

  const entry = db.prepare(
    'SELECT * FROM diary_entries WHERE id = ?'
  ).get(Number(result.lastInsertRowid));

  res.status(201).json({
    success: true,
    entry: {
      ...entry,
      missing_fields: JSON.parse(entry.missing_fields)
    }
  });
});

// Удаление блюда из дневника
app.delete('/api/diary/entries/:id', (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      error: 'Некорректный ID записи'
    });
  }

  const result = db.prepare(
    'DELETE FROM diary_entries WHERE id = ?'
  ).run(id);

  if (result.changes === 0) {
    return res.status(404).json({
      error: 'Запись не найдена'
    });
  }

  res.json({ success: true });
});

seedDefaultMenu();
db.prepare(`
  UPDATE menus
  SET source = 'image_url'
  WHERE source = 'saved'
`).run();

app.listen(PORT, () => {
  console.log(`Приложение запущено: http://localhost:${PORT}`);
});
