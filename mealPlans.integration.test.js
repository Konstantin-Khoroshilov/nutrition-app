const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

function injectModule(request, exports) {
    const filename = require.resolve(request);
    const mockedModule = new Module(filename);
    mockedModule.filename = filename;
    mockedModule.loaded = true;
    mockedModule.exports = exports;
    require.cache[filename] = mockedModule;
}

test('stores plans by date, replaces diary plans, and reuses dish corrections', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE menus (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL,
            recognized_at TEXT
        );
        CREATE TABLE menu_dishes (
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
        CREATE TABLE dish_nutrition_corrections (
            normalized_name TEXT NOT NULL,
            portion_weight_g REAL NOT NULL,
            calories REAL,
            protein REAL,
            fat REAL,
            carbs REAL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (normalized_name, portion_weight_g)
        );
        CREATE TABLE goals (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            calories REAL NOT NULL,
            protein REAL NOT NULL,
            fat REAL NOT NULL,
            carbs REAL NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE daily_goals (
            diary_date TEXT PRIMARY KEY,
            calories REAL NOT NULL,
            protein REAL NOT NULL,
            fat REAL NOT NULL,
            carbs REAL NOT NULL
        );
        CREATE TABLE diary_entries (
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
            created_at TEXT NOT NULL,
            meal_plan_date TEXT
        );
        CREATE TABLE daily_meal_plans (
            diary_date TEXT PRIMARY KEY,
            menu_ids TEXT NOT NULL,
            plan_data TEXT NOT NULL,
            selected_plan_id INTEGER,
            created_at TEXT NOT NULL
        );
    `);
    db.prepare(`
        INSERT INTO menus (name, source, created_at)
        VALUES ('My menu', 'manual', ?)
    `).run(new Date().toISOString());

    injectModule('./database/database', db);
    const { validateMealPlans } = require('./mealPlanner');

    injectModule('./mealPlanner', {
        generateMealPlans: async options => {
            const [breakfast, lunch, dinner] = options.dishes;

            return validateMealPlans([
                {
                    title: 'First option',
                    meals: {
                        breakfast: [{ dish_id: breakfast.id, servings: 1 }],
                        lunch: [{ dish_id: lunch.id, servings: 1 }],
                        snack: [],
                        dinner: [{ dish_id: dinner.id, servings: 1 }]
                    }
                },
                {
                    title: 'Second option',
                    meals: {
                        breakfast: [{ dish_id: lunch.id, servings: 1 }],
                        lunch: [{ dish_id: breakfast.id, servings: 1 }],
                        snack: [],
                        dinner: [{ dish_id: dinner.id, servings: 1 }]
                    }
                }
            ], options.dishes, options.goals, options.count, options.tolerancePercent);
        }
    });

    injectModule('./recognize', {
        recognizeMenuBuffer: async () => ({
            recognized_at: new Date().toISOString(),
            dishes: [{
                name: 'Oatmeal',
                portion_weight_g: 100,
                calories_per_100g: null,
                protein_per_100g: 10,
                fat_per_100g: 5,
                carbs_per_100g: 30
            }]
        })
    });

    const app = require('./server');
    const server = app.listen(0);
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function request(url, method = 'GET', body) {
        const response = await fetch(`${baseUrl}${url}`, {
            method,
            headers: body === undefined
                ? {}
                : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = await response.json();

        assert.ok(response.ok, `${method} ${url}: ${data.error || response.status}`);
        return data;
    }

    try {
        const date = '2026-11-15';
        await request('/api/goals', 'PUT', {
            diary_date: date,
            calories: 1500,
            protein: 90,
            fat: 50,
            carbs: 160
        });

        const menuId = (await request('/api/menus/manual', 'POST', {})).id;
        const dishes = [
            ['Oatmeal', 100, 300, 10, 5, 30],
            ['Rice bowl', 200, 500, 20, 10, 70],
            ['Fish plate', 180, 600, 40, 25, 20]
        ];
        let oatmealId;

        for (const [name, portion_weight_g, calories, protein, fat, carbs] of dishes) {
            const menu = await request(`/api/menus/${menuId}/dishes`, 'POST', {
                name,
                portion_weight_g,
                calories,
                protein,
                fat,
                carbs
            });

            if (name === 'Oatmeal') {
                oatmealId = menu.dishes.find(dish => dish.name === name).id;
            }
        }

        await request(`/api/menus/${menuId}/dishes/${oatmealId}`, 'PUT', {
            name: 'Oatmeal',
            portion_weight_g: 100,
            calories: 321,
            protein: 10,
            fat: 5,
            carbs: 30
        });
        await request('/api/diary/entries', 'POST', {
            diary_date: date,
            meal_type: 'snack',
            dish_name: 'Manual diary entry',
            portion_weight_g: 50,
            calories: 100,
            protein: 2,
            fat: 3,
            carbs: 15
        });

        const generated = await request('/api/meal-plans', 'POST', {
            date,
            menu_ids: [menuId]
        });
        assert.equal(generated.plans.length, 2);
        assert.equal(
            (await request(`/api/meal-plans?date=${date}`)).plan.plans.length,
            2
        );
        assert.equal(
            (await request('/api/meal-plans?date=2026-11-16')).plan,
            null
        );

        await request('/api/meal-plans/apply', 'POST', {
            date,
            plan_id: generated.plans[0].id
        });
        await request('/api/meal-plans/apply', 'POST', {
            date,
            plan_id: generated.plans[1].id
        });

        let diary = await request(`/api/diary?date=${date}`);
        assert.equal(diary.entries.length, 4);
        assert.equal(
            diary.entries.filter(entry => entry.meal_plan_date === date).length,
            3
        );
        assert.equal(
            diary.entries.filter(entry => entry.dish_name === 'Manual diary entry').length,
            1
        );
        assert.equal(
            (await request(`/api/meal-plans?date=${date}`)).plan.selected_plan_id,
            generated.plans[1].id
        );

        await request('/api/diary/entries', 'POST', {
            diary_date: '2026-11-16',
            meal_type: 'breakfast',
            dish_name: 'Other day entry',
            portion_weight_g: 50,
            calories: 100,
            protein: 2,
            fat: 3,
            carbs: 15
        });
        const cleared = await request(
            `/api/diary?date=${date}`,
            'DELETE'
        );
        assert.equal(cleared.deleted_entries, 4);
        assert.equal((await request(`/api/diary?date=${date}`)).entries.length, 0);
        assert.equal(
            (await request(`/api/meal-plans?date=${date}`)).plan.selected_plan_id,
            null
        );
        assert.equal(
            (await request('/api/diary?date=2026-11-16')).entries.length,
            1
        );

        await request(`/api/menus/${menuId}/dishes/${oatmealId}`, 'PUT', {
            name: 'Oatmeal',
            portion_weight_g: 100,
            calories: 321,
            protein: 10,
            fat: 5,
            carbs: 30
        });
        assert.equal((await request(`/api/meal-plans?date=${date}`)).plan, null);

        const recognized = await request('/api/menus/recognize', 'POST', {
            name: 'Recognized menu',
            imageData: 'data:image/png;base64,QQ=='
        });
        const correctedDish = recognized.dishes.find(
            dish => dish.name === 'Oatmeal'
        );
        assert.equal(correctedDish.calories, 321);
        assert.equal(correctedDish.nutrition_status, 'menu');
    } finally {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
        db.close();
    }
});
