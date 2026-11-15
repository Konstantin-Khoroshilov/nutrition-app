
const express = require('express');
const path = require('path');
const db = require('./database/database');
const fs = require('fs');
const { recognizeMenuBuffer } = require('./recognize');
const { downloadImage, MAX_IMAGE_BYTES } = require('./imageDownloader');
const { generateMealPlans } = require('./mealPlanner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '14mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const mealTypes = ['breakfast', 'lunch', 'snack', 'dinner'];
const planMenuSources = ['image_url', 'image_upload', 'manual'];
const mealPlanCount = 3;
const mealPlanTolerancePercent = 15;

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

function createRequestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeDishName(name) {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function invalidateMealPlansForMenu(menuId) {
  const plans = db.prepare(
    'SELECT diary_date, menu_ids FROM daily_meal_plans'
  ).all();

  for (const plan of plans) {
    if (JSON.parse(plan.menu_ids).includes(menuId)) {
      db.prepare('DELETE FROM daily_meal_plans WHERE diary_date = ?')
        .run(plan.diary_date);
    }
  }
}

function applyNutritionCorrections(dishes) {
  const getCorrection = db.prepare(`
    SELECT calories, protein, fat, carbs
    FROM dish_nutrition_corrections
    WHERE normalized_name = ? AND portion_weight_g = ?
  `);
  const nutrients = ['calories', 'protein', 'fat', 'carbs'];

  return dishes.map(dish => {
    if (dish.portion_weight_g === null) {
      return dish;
    }

    const correction = getCorrection.get(
      normalizeDishName(dish.name),
      dish.portion_weight_g
    );

    if (!correction) {
      return dish;
    }

    const missingFields = new Set(dish.missing_fields);
    const corrected = { ...dish };

    for (const nutrient of nutrients) {
      if (corrected[nutrient] === null && correction[nutrient] !== null) {
        corrected[nutrient] = correction[nutrient];
        missingFields.delete(nutrient);
      }
    }

    corrected.missing_fields = [...missingFields];
    corrected.nutrition_status = corrected.missing_fields.length === 0
      ? 'menu'
      : 'approximate';

    return corrected;
  });
}

function getSelectedPlanMenus(menuIds) {
  if (
    !Array.isArray(menuIds) ||
    menuIds.length < 1 ||
    menuIds.length > planMenuSources.length ||
    !menuIds.every(id => Number.isInteger(id) && id > 0) ||
    new Set(menuIds).size !== menuIds.length
  ) {
    throw createRequestError('Выберите от одного до трёх разных меню');
  }

  const getMenuById = db.prepare(`
    SELECT id, name, source
    FROM menus AS menu
    WHERE id = ?
      AND source IN ('image_url', 'image_upload', 'manual')
      AND id = (
        SELECT MAX(latest.id)
        FROM menus AS latest
        WHERE latest.source = menu.source
      )
  `);
  const selectedMenus = menuIds.map(id => getMenuById.get(id));

  if (selectedMenus.some(menu => !menu)) {
    throw createRequestError(
      'Одно из выбранных меню больше не доступно. Обновите список меню.',
      409
    );
  }

  return selectedMenus;
}

function hasCompleteNutrition(dish) {
  return typeof dish.portion_weight_g === 'number' &&
    Number.isFinite(dish.portion_weight_g) &&
    dish.portion_weight_g > 0 &&
    ['calories', 'protein', 'fat', 'carbs'].every(nutrient =>
      typeof dish[nutrient] === 'number' &&
      Number.isFinite(dish[nutrient]) &&
      dish[nutrient] >= 0
    );
}

function insertDiaryEntry(entry) {
  const nutrients = {
    calories: entry.calories,
    protein: entry.protein,
    fat: entry.fat,
    carbs: entry.carbs
  };
  const missingFields = entry.missing_fields || [];
  const hasMissingData = missingFields.length > 0 ||
    Object.values(nutrients).some(value => value == null);

  const result = db.prepare(`
    INSERT INTO diary_entries (
      diary_date, meal_type, dish_name, portion_weight_g,
      calories, protein, fat, carbs, missing_fields,
      nutrition_status, created_at, meal_plan_date
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.diary_date,
    entry.meal_type,
    entry.dish_name,
    entry.portion_weight_g,
    nutrients.calories,
    nutrients.protein,
    nutrients.fat,
    nutrients.carbs,
    JSON.stringify(missingFields),
    hasMissingData ? 'approximate' : 'complete',
    new Date().toISOString(),
    entry.meal_plan_date || null
  );

  return Number(result.lastInsertRowid);
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
  const correctedDishes = applyNutritionCorrections(dishes);
  const existingMenu = db.prepare(
    'SELECT id FROM menus WHERE source = ? ORDER BY id DESC LIMIT 1'
  ).get(source);

  if (!existingMenu) {
    return insertMenu(name, source, correctedDishes, recognizedAt);
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
    insertMenuDishes(existingMenu.id, correctedDishes);
    invalidateMealPlansForMenu(existingMenu.id);
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
  const activeMenu = db.prepare(
    'SELECT MAX(id) AS id FROM menus WHERE source = ?'
  ).get(source);

  db.exec('BEGIN');

  try {
    if (activeMenu.id !== null) {
      invalidateMealPlansForMenu(activeMenu.id);
    }

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

app.get('/api/meal-plans', (req, res) => {
  const { date } = req.query;

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: 'Укажите дату в формате YYYY-MM-DD'
    });
  }

  const savedPlan = db.prepare(`
    SELECT plan_data, selected_plan_id
    FROM daily_meal_plans
    WHERE diary_date = ?
  `).get(date);

  res.json({
    plan: savedPlan
      ? {
          ...JSON.parse(savedPlan.plan_data),
          selected_plan_id: savedPlan.selected_plan_id
        }
      : null
  });
});

app.post('/api/meal-plans', async (req, res) => {
  const { date, menu_ids: menuIds } = req.body || {};

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: 'Укажите дату в формате YYYY-MM-DD'
    });
  }

  try {
    const selectedMenus = getSelectedPlanMenus(menuIds);
    const goals = getOrCreateDailyGoals(date);

    if (!goals || !['calories', 'protein', 'fat', 'carbs'].every(nutrient =>
      Number.isFinite(goals[nutrient]) && goals[nutrient] > 0
    )) {
      return res.status(400).json({
        error: 'Сначала задайте положительные дневные цели по КБЖУ.'
      });
    }

    const placeholders = menuIds.map(() => '?').join(', ');
    const allDishes = db.prepare(`
      SELECT id, menu_id, name, portion_weight_g,
        calories, protein, fat, carbs
      FROM menu_dishes
      WHERE menu_id IN (${placeholders})
    `).all(...menuIds);
    const eligibleDishes = allDishes.filter(hasCompleteNutrition);

    if (eligibleDishes.length === 0) {
      return res.status(422).json({
        error: 'В выбранных меню нет блюд с полным КБЖУ и весом порции.'
      });
    }

    const dishesByMenu = new Map(
      selectedMenus.map(menu => [menu.id, []])
    );

    for (const dish of eligibleDishes) {
      dishesByMenu.get(dish.menu_id).push({
        id: dish.id,
        name: dish.name,
        portion_weight_g: dish.portion_weight_g,
        calories: dish.calories,
        protein: dish.protein,
        fat: dish.fat,
        carbs: dish.carbs
      });
    }

    const promptMenus = selectedMenus.map(menu => ({
      id: menu.id,
      name: menu.name,
      dishes: dishesByMenu.get(menu.id)
    }));
    const targetGoals = {
      calories: goals.calories,
      protein: goals.protein,
      fat: goals.fat,
      carbs: goals.carbs
    };
    const plans = await generateMealPlans({
      menus: promptMenus,
      dishes: eligibleDishes,
      goals: targetGoals,
      count: mealPlanCount,
      tolerancePercent: mealPlanTolerancePercent
    });

    const planData = {
      date,
      menu_ids: menuIds,
      menu_names: selectedMenus.map(menu => menu.name),
      goals: targetGoals,
      tolerance_percent: mealPlanTolerancePercent,
      excluded_dish_count: allDishes.length - eligibleDishes.length,
      plans
    };

    db.prepare(`
      INSERT INTO daily_meal_plans (
        diary_date, menu_ids, plan_data, selected_plan_id, created_at
      )
      VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(diary_date) DO UPDATE SET
        menu_ids = excluded.menu_ids,
        plan_data = excluded.plan_data,
        selected_plan_id = NULL,
        created_at = excluded.created_at
    `).run(
      date,
      JSON.stringify(menuIds),
      JSON.stringify(planData),
      new Date().toISOString()
    );

    res.json({ ...planData, selected_plan_id: null });
  } catch (error) {
    console.error('Ошибка составления плана питания:', error);
    res.status(error.statusCode || 500).json({
      error: error.message || 'Не удалось составить план питания'
    });
  }
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

app.put('/api/menus/:menuId/dishes/:dishId', (req, res) => {
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

  const dish = db.prepare(`
    SELECT id
    FROM menu_dishes
    WHERE id = ? AND menu_id = ?
  `).get(dishId, menuId);

  if (!dish) {
    return res.status(404).json({ error: 'Блюдо не найдено в этом меню' });
  }

  const { name, portion_weight_g, calories, protein, fat, carbs } =
    req.body || {};
  const normalizedName = typeof name === 'string' ? name.trim() : '';

  if (!normalizedName || normalizedName.length > 200) {
    return res.status(400).json({
      error: 'Укажите название блюда (не более 200 символов)'
    });
  }

  if (
    portion_weight_g !== null &&
    (typeof portion_weight_g !== 'number' ||
      !Number.isFinite(portion_weight_g) ||
      portion_weight_g <= 0)
  ) {
    return res.status(400).json({
      error: 'Вес порции должен быть больше нуля или оставлен пустым'
    });
  }

  const nutrients = { calories, protein, fat, carbs };

  for (const [nutrient, value] of Object.entries(nutrients)) {
    if (
      value !== null &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      return res.status(400).json({
        error: `Укажите корректное значение показателя «${nutrient}»`
      });
    }
  }

  const missingFields = [];

  if (portion_weight_g === null) {
    missingFields.push('portion_weight_g');
  }

  for (const [nutrient, value] of Object.entries(nutrients)) {
    if (value === null) {
      missingFields.push(nutrient);
    }
  }

  const nutritionStatus = missingFields.length > 0
    ? 'approximate'
    : 'manual';

  db.exec('BEGIN');

  try {
    db.prepare(`
      UPDATE menu_dishes
      SET name = ?, portion_weight_g = ?, calories = ?, protein = ?,
        fat = ?, carbs = ?, nutrition_status = ?, missing_fields = ?
      WHERE id = ? AND menu_id = ?
    `).run(
      normalizedName,
      portion_weight_g,
      calories,
      protein,
      fat,
      carbs,
      nutritionStatus,
      JSON.stringify(missingFields),
      dishId,
      menuId
    );

    if (portion_weight_g !== null) {
      db.prepare(`
        INSERT INTO dish_nutrition_corrections (
          normalized_name, portion_weight_g, calories, protein, fat, carbs,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(normalized_name, portion_weight_g) DO UPDATE SET
          calories = COALESCE(excluded.calories, calories),
          protein = COALESCE(excluded.protein, protein),
          fat = COALESCE(excluded.fat, fat),
          carbs = COALESCE(excluded.carbs, carbs),
          updated_at = excluded.updated_at
      `).run(
        normalizeDishName(normalizedName),
        portion_weight_g,
        calories,
        protein,
        fat,
        carbs,
        new Date().toISOString()
      );
    }

    invalidateMealPlansForMenu(menuId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  res.json(getMenu(menuId));
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

  invalidateMealPlansForMenu(menuId);

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
    db.prepare('DELETE FROM daily_meal_plans WHERE diary_date = ?')
      .run(diary_date);
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

// Замена выбранного плана питания в дневнике
app.post('/api/meal-plans/apply', (req, res) => {
  const { date, plan_id: planId } = req.body || {};

  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'Некорректная дата плана' });
  }

  if (!Number.isInteger(planId) || planId < 1) {
    return res.status(400).json({ error: 'Некорректный вариант плана' });
  }

  const savedPlan = db.prepare(`
    SELECT plan_data, selected_plan_id
    FROM daily_meal_plans
    WHERE diary_date = ?
  `).get(date);

  if (!savedPlan) {
    return res.status(404).json({
      error: 'План на эту дату не найден. Составьте новые рекомендации.'
    });
  }

  const planData = JSON.parse(savedPlan.plan_data);
  const plan = planData.plans.find(candidate => candidate.id === planId);

  if (!plan) {
    return res.status(404).json({ error: 'Выбранный вариант плана не найден' });
  }

  let selectedMenus;
  try {
    selectedMenus = getSelectedPlanMenus(planData.menu_ids);
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      error: error.message
    });
  }

  const selectedMenuIds = new Set(selectedMenus.map(menu => menu.id));
  const getDish = db.prepare(`
    SELECT dish.id, dish.menu_id, dish.name, dish.portion_weight_g,
      dish.calories, dish.protein, dish.fat, dish.carbs
    FROM menu_dishes AS dish
    WHERE dish.id = ?
  `);
  const preparedEntries = [];

  for (const [mealType, dishes] of Object.entries(plan.meals)) {
    if (!mealTypes.includes(mealType) || !Array.isArray(dishes)) {
      return res.status(409).json({ error: 'Сохранённый план повреждён' });
    }

    for (const plannedDish of dishes) {
      if (
        !Number.isInteger(plannedDish.dish_id) ||
        ![1, 2].includes(plannedDish.servings)
      ) {
        return res.status(409).json({ error: 'Сохранённый план повреждён' });
      }

      const dish = getDish.get(plannedDish.dish_id);

      if (!dish || !selectedMenuIds.has(dish.menu_id)) {
        return res.status(409).json({
          error: 'Одно из блюд больше не доступно в выбранных меню. Составьте новый план.'
        });
      }

      if (
        !hasCompleteNutrition(dish) ||
        dish.name !== plannedDish.name ||
        dish.portion_weight_g * plannedDish.servings !==
          plannedDish.portion_weight_g ||
        ['calories', 'protein', 'fat', 'carbs'].some(nutrient =>
          dish[nutrient] * plannedDish.servings !== plannedDish[nutrient]
        )
      ) {
        return res.status(409).json({
          error: `Данные блюда «${dish.name}» изменились. Составьте новый план.`
        });
      }

      preparedEntries.push({
        dish,
        meal_type: mealType,
        servings: plannedDish.servings
      });
    }
  }

  if (preparedEntries.length === 0 || preparedEntries.length > 40) {
    return res.status(409).json({ error: 'Сохранённый план повреждён' });
  }

  if (savedPlan.selected_plan_id === planId) {
    return res.json({
      success: true,
      selected_plan_id: planId,
      date
    });
  }

  db.exec('BEGIN');

  try {
    db.prepare(`
      DELETE FROM diary_entries
      WHERE diary_date = ? AND meal_plan_date = ?
    `).run(date, date);

    for (const { dish, meal_type, servings } of preparedEntries) {
      insertDiaryEntry({
        diary_date: date,
        meal_type,
        dish_name: servings > 1
          ? `${dish.name} (${servings} порции)`
          : dish.name,
        portion_weight_g: dish.portion_weight_g * servings,
        calories: dish.calories * servings,
        protein: dish.protein * servings,
        fat: dish.fat * servings,
        carbs: dish.carbs * servings,
        missing_fields: [],
        meal_plan_date: date
      });
    }

    db.prepare(`
      UPDATE daily_meal_plans
      SET selected_plan_id = ?
      WHERE diary_date = ?
    `).run(planId, date);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  res.status(201).json({
    success: true,
    entries_added: preparedEntries.length,
    selected_plan_id: planId,
    date
  });
});

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

  const entryId = insertDiaryEntry({
    diary_date,
    meal_type,
    dish_name: dish_name.trim(),
    portion_weight_g,
    calories: calories ?? null,
    protein: protein ?? null,
    fat: fat ?? null,
    carbs: carbs ?? null,
    missing_fields
  });

  const entry = db.prepare(
    'SELECT * FROM diary_entries WHERE id = ?'
  ).get(entryId);

  res.status(201).json({
    success: true,
    entry: {
      ...entry,
      missing_fields: JSON.parse(entry.missing_fields)
    }
  });
});

app.delete('/api/diary', (req, res) => {
  const { date } = req.query;

  if (!isValidDate(date)) {
    return res.status(400).json({
      error: 'Укажите дату в формате YYYY-MM-DD'
    });
  }

  db.exec('BEGIN');

  try {
    const result = db.prepare(
      'DELETE FROM diary_entries WHERE diary_date = ?'
    ).run(date);
    db.prepare(`
      UPDATE daily_meal_plans
      SET selected_plan_id = NULL
      WHERE diary_date = ?
    `).run(date);
    db.exec('COMMIT');

    res.json({
      success: true,
      date,
      deleted_entries: result.changes
    });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

// Удаление блюда из дневника
app.delete('/api/diary/entries/:id', (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      error: 'Некорректный ID записи'
    });
  }

  const entry = db.prepare(`
    SELECT diary_date, meal_plan_date
    FROM diary_entries
    WHERE id = ?
  `).get(id);

  const result = db.prepare(
    'DELETE FROM diary_entries WHERE id = ?'
  ).run(id);

  if (result.changes === 0) {
    return res.status(404).json({
      error: 'Запись не найдена'
    });
  }

  if (entry?.meal_plan_date) {
    db.prepare(`
      UPDATE daily_meal_plans
      SET selected_plan_id = NULL
      WHERE diary_date = ?
    `).run(entry.diary_date);
  }

  res.json({ success: true });
});

seedDefaultMenu();
db.prepare(`
  UPDATE menus
  SET source = 'image_url'
  WHERE source = 'saved'
`).run();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Приложение запущено: http://localhost:${PORT}`);
  });
}

module.exports = app;
