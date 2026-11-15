
const express = require('express');
const path = require('path');
const db = require('./database/database');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const mealTypes = ['breakfast', 'lunch', 'snack', 'dinner'];

function isValidDate(date) {
  return typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function getOrCreateDailyGoals(date) {
  let dailyGoals = db.prepare(
    'SELECT * FROM daily_goals WHERE diary_date = ?'
  ).get(date);

  if (dailyGoals) {
    return dailyGoals;
  }

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


// Получение блюд из меню Freshvote
app.get('/api/menu', (req, res) => {
    try {
        const menuPath = path.join(__dirname, 'menu-calculated.json');

        if (!fs.existsSync(menuPath)) {
            return res.status(404).json({
                error: 'Файл menu-calculated.json не найден'
            });
        }

        const menuData = JSON.parse(
            fs.readFileSync(menuPath, 'utf8')
        );

        if (!Array.isArray(menuData.dishes)) {
            return res.status(500).json({
                error: 'В файле меню отсутствует массив dishes'
            });
        }

        const dishes = menuData.dishes.map((dish, index) => {
            const portion = dish.nutrition_per_portion || {};

            const nutrients = {
                calories: portion.calories ?? null,
                protein: portion.protein ?? null,
                fat: portion.fat ?? null,
                carbs: portion.carbs ?? null
            };

            const missingFields = [
                ...(dish.missing_fields || [])
            ];

            // Дополнительно проверяем, какие показатели отсутствуют
            for (const [field, value] of Object.entries(nutrients)) {
                if (value === null && !missingFields.includes(field)) {
                    missingFields.push(field);
                }
            }

            return {
                id: index,
                name: dish.name,
                portion_weight_g:
                    dish.portion_weight_g ?? portion.weight_g ?? null,
                ...nutrients,
                nutrition_status: dish.nutrition_status || 'unknown',
                calculation_status: dish.calculation_status || 'unknown',
                missing_fields: missingFields
            };
        });

        res.json({
            source: menuData.source,
            total_dishes: dishes.length,
            dishes
        });

    } catch (error) {
        console.error('Ошибка загрузки меню:', error);

        res.status(500).json({
            error: 'Не удалось прочитать меню Freshvote'
        });
    }
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

app.listen(PORT, () => {
  console.log(`Приложение запущено: http://localhost:${PORT}`);
});
