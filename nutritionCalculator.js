
const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, 'menu.json');
const OVERRIDES_FILE = path.join(__dirname, 'nutritionOverrides.json');
const OUTPUT_FILE = path.join(__dirname, 'menu-calculated.json');

const NUTRITION_FIELDS = [
    'portion_weight_g',
    'calories_per_100g',
    'protein_per_100g',
    'fat_per_100g',
    'carbs_per_100g'
];

// Преобразование и проверка числовых значений
function getValidNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
        return null;
    }

    return number;
}

// Округление до одного знака
function round(value) {
    return Math.round((value + Number.EPSILON) * 10) / 10;
}

// Чтение JSON-файла
function readJson(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Файл не найден: ${filePath}`);
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Создание карты дополнительных данных
function createOverridesMap(overrides) {
    if (!overrides || !Array.isArray(overrides.dishes)) {
        throw new Error(
            'В nutritionOverrides.json отсутствует массив dishes.'
        );
    }

    const map = new Map();

    for (const override of overrides.dishes) {
        if (!override.name || !override.values) {
            throw new Error(
                'В одной из записей nutritionOverrides.json отсутствует name или values.'
            );
        }

        if (!['reference', 'estimated'].includes(override.source_type)) {
            throw new Error(
                `Некорректный source_type у блюда: ${override.name}`
            );
        }

        const key = override.name.trim().toLowerCase();

        if (map.has(key)) {
            throw new Error(
                `Повторяющаяся запись в nutritionOverrides.json: ${override.name}`
            );
        }

        map.set(key, override);
    }

    return map;
}

// Дополняем данные блюда
function enrichDish(dish, override) {
    const result = { ...dish };
    const provenance = {};

    // Отмечаем показатели, полученные из меню
    for (const field of NUTRITION_FIELDS) {
        if (getValidNumber(result[field]) !== null) {
            provenance[field] = {
                type: 'menu',
                source_name: 'Freshvote'
            };
        }
    }

    // Заполняем только отсутствующие показатели
    if (override) {
        for (const field of NUTRITION_FIELDS) {
            const currentValue = getValidNumber(result[field]);
            const overrideValue = getValidNumber(
                override.values[field]
            );

            if (currentValue === null && overrideValue !== null) {
                result[field] = overrideValue;

                provenance[field] = {
                    type: override.source_type,
                    source_name: override.source_name || null,
                    source_url: override.source_url || null,
                    notes: override.notes || null
                };
            }
        }
    }

    result.nutrition_provenance = provenance;

    // Определяем общий статус происхождения данных
    const sources = Object.values(provenance).map(
        item => item.type
    );

    if (sources.includes('estimated')) {
        result.nutrition_status = 'estimated';
    } else if (sources.includes('reference')) {
        result.nutrition_status = 'reference';
    } else {
        result.nutrition_status = 'menu';
    }

    return result;
}

// Расчёт питательной ценности порции
function calculateDish(dish) {
    const weight = getValidNumber(dish.portion_weight_g);
    const calories = getValidNumber(dish.calories_per_100g);
    const protein = getValidNumber(dish.protein_per_100g);
    const fat = getValidNumber(dish.fat_per_100g);
    const carbs = getValidNumber(dish.carbs_per_100g);

    const values = {
        portion_weight_g: weight,
        calories_per_100g: calories,
        protein_per_100g: protein,
        fat_per_100g: fat,
        carbs_per_100g: carbs
    };

    const missingFields = NUTRITION_FIELDS.filter(
        field => values[field] === null
    );

    // Без веса нельзя рассчитать питательную ценность порции.
    // При этом исходные показатели на 100 г сохраняются.
    if (missingFields.length > 0) {
        return {
            ...dish,
            nutrition_per_portion: null,
            calculation_status: 'incomplete_data',
            missing_fields: missingFields
        };
    }

    const multiplier = weight / 100;

    return {
        ...dish,
        nutrition_per_portion: {
            weight_g: weight,
            calories: round(calories * multiplier),
            protein: round(protein * multiplier),
            fat: round(fat * multiplier),
            carbs: round(carbs * multiplier)
        },
        calculation_status: 'calculated',
        missing_fields: []
    };
}

// Основная функция
function calculateMenu() {
    console.log('Открываем menu.json...');

    const menu = readJson(INPUT_FILE);
    const overrides = readJson(OVERRIDES_FILE);

    if (!menu || !Array.isArray(menu.dishes)) {
        throw new Error(
            'В menu.json отсутствует массив dishes.'
        );
    }

    const overridesMap = createOverridesMap(overrides);

    console.log(`Получено блюд: ${menu.dishes.length}`);
    console.log(`Дополнительных записей: ${overridesMap.size}`);
    console.log('Дополняем данные и рассчитываем показатели...');

    // Обогащаем данные и рассчитываем каждое блюдо
    const calculatedDishes = menu.dishes.map(dish => {
        const key = dish.name.trim().toLowerCase();
        const override = overridesMap.get(key);

        const enrichedDish = enrichDish(dish, override);

        return calculateDish(enrichedDish);
    });

    const calculatedCount = calculatedDishes.filter(
        dish => dish.calculation_status === 'calculated'
    ).length;

    const incompleteCount =
        calculatedDishes.length - calculatedCount;

    const statusCounts = {
        menu: 0,
        reference: 0,
        estimated: 0
    };

    for (const dish of calculatedDishes) {
        statusCounts[dish.nutrition_status]++;
    }

    const result = {
        ...menu,
        calculated_at: new Date().toISOString(),
        total_dishes: calculatedDishes.length,
        calculated_count: calculatedCount,
        incomplete_count: incompleteCount,
        nutrition_status_counts: statusCounts,
        dishes: calculatedDishes
    };

    fs.writeFileSync(
        OUTPUT_FILE,
        JSON.stringify(result, null, 2),
        'utf8'
    );

    console.log('----------------------------');
    console.log(`Всего блюд: ${calculatedDishes.length}`);
    console.log(`Рассчитано порций: ${calculatedCount}`);
    console.log(`Неполные данные: ${incompleteCount}`);
    console.log('----------------------------');
    console.log('Происхождение данных:');
    console.log(`Из меню: ${statusCounts.menu}`);
    console.log(`Справочные: ${statusCounts.reference}`);
    console.log(`Приблизительные: ${statusCounts.estimated}`);
    console.log('----------------------------');
    console.log(`Результат сохранён: ${OUTPUT_FILE}`);
}

try {
    calculateMenu();
} catch (error) {
    console.error('Ошибка:', error.message);
    process.exitCode = 1;
}
