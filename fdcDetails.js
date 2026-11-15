
require('dotenv').config();

const API_KEY = process.env.USDA_API_KEY;

// ID красного сладкого перца из результатов предыдущего поиска
const FDC_ID = 2258590;

async function getFoodDetails(fdcId) {
    const url =
        `https://api.nal.usda.gov/fdc/v1/food/${fdcId}` +
        `?api_key=${encodeURIComponent(API_KEY)}`;

    const response = await fetch(url);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(
            `Ошибка USDA API: ${response.status}\n${error}`
        );
    }

    return await response.json();
}


function getNutrient(food, nutrientIds) {
    // Поддерживаем как один ID, так и массив ID
    const ids = Array.isArray(nutrientIds)
        ? nutrientIds
        : [nutrientIds];

    // Проверяем ID по приоритету
    for (const id of ids) {
        const nutrient = food.foodNutrients.find(item => {
            return item.nutrient?.id === id;
        });

        if (nutrient) {
            return {
                value: nutrient.amount ?? null,
                unit: nutrient.nutrient?.unitName ?? null,
                name: nutrient.nutrient?.name ?? null,
                nutrient_id: nutrient.nutrient?.id ?? null
            };
        }
    }

    return null;
}


async function main() {
    console.log('Получаем подробную информацию...');

    const food = await getFoodDetails(FDC_ID);
    console.log('\nВсе энергетические показатели:\n');

    for (const item of food.foodNutrients) {
        const name = item.nutrient?.name ?? item.name ?? '';

        if (name.toLowerCase().includes('energy')) {
            console.dir(item, { depth: null });
        }
    }

    console.log('\nПродукт:', food.description);
    console.log('Категория:', food.foodCategory);

const nutrients = {
    calories: getNutrient(food, [1008, 2047, 2048]),
    protein: getNutrient(food, [1003]),
    fat: getNutrient(food, [1004]),
    carbs: getNutrient(food, [1005])
};

    console.log('\nПищевая ценность:');
    console.log(nutrients);
}

main().catch(error => {
    console.error('\nОшибка:', error.message);
});
