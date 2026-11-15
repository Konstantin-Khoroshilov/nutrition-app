
const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, 'menu-calculated.json');
const OUTPUT_FILE = path.join(__dirname, 'incomplete-dishes.json');

// Проверяем наличие файла
function readMenu() {
    if (!fs.existsSync(INPUT_FILE)) {
        throw new Error(`Файл ${INPUT_FILE} не найден.`);
    }

    const data = JSON.parse(
        fs.readFileSync(INPUT_FILE, 'utf8')
    );

    if (!data || !Array.isArray(data.dishes)) {
        throw new Error(
            'В файле отсутствует массив dishes.'
        );
    }

    return data;
}

// Определяем отсутствующие показатели
function findMissingFields(dish) {
    const fields = {
        portion_weight_g: 'вес порции',
        calories_per_100g: 'калории',
        protein_per_100g: 'белки',
        fat_per_100g: 'жиры',
        carbs_per_100g: 'углеводы'
    };

    const missing = [];

    for (const [field, label] of Object.entries(fields)) {
        const value = dish[field];

        if (
            value === null ||
            value === undefined ||
            value === '' ||
            !Number.isFinite(Number(value)) ||
            Number(value) < 0
        ) {
            missing.push({
                field,
                label
            });
        }
    }

    return missing;
}

// Основная функция
function findIncompleteDishes() {
    console.log('Открываем menu-calculated.json...');

    const menu = readMenu();

    console.log(`Всего блюд: ${menu.dishes.length}`);
    console.log('Проверяем полноту данных...');

    const incompleteDishes = [];

    menu.dishes.forEach((dish, index) => {
        const missingFields = findMissingFields(dish);

        if (missingFields.length > 0) {
            incompleteDishes.push({
                original_index: index,
                name: dish.name,
                portion_weight_g: dish.portion_weight_g,
                calories_per_100g: dish.calories_per_100g,
                protein_per_100g: dish.protein_per_100g,
                fat_per_100g: dish.fat_per_100g,
                carbs_per_100g: dish.carbs_per_100g,
                missing_fields: missingFields
            });
        }
    });

    const result = {
        source: menu.source,
        source_image: menu.source_image,
        recognized_at: menu.recognized_at,
        generated_at: new Date().toISOString(),
        total_dishes: menu.dishes.length,
        incomplete_count: incompleteDishes.length,
        dishes: incompleteDishes
    };

    fs.writeFileSync(
        OUTPUT_FILE,
        JSON.stringify(result, null, 2),
        'utf8'
    );

    console.log('----------------------------');
    console.log(`Всего блюд: ${menu.dishes.length}`);
    console.log(`С неполными данными: ${incompleteDishes.length}`);
    console.log(`С полными данными: ${menu.dishes.length - incompleteDishes.length}`);

    if (incompleteDishes.length > 0) {
        console.log('\nСписок блюд:');

        incompleteDishes.forEach((dish, index) => {
            const missing = dish.missing_fields
                .map(field => field.label)
                .join(', ');

            console.log(`${index + 1}. ${dish.name}`);
            console.log(`   Не указано: ${missing}`);
        });
    }

    console.log('\nРезультат сохранён: incomplete-dishes.json');
}

try {
    findIncompleteDishes();
} catch (error) {
    console.error('Ошибка:', error.message);
    process.exitCode = 1;
}
