
require('dotenv').config();

const API_KEY = process.env.USDA_API_KEY;

async function searchFood(query) {
    const url =
        `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(API_KEY)}`;

    console.log(`Ищем продукт: ${query}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            query: query,
            dataType: [
                'Foundation',
                'SR Legacy',
                'Survey (FNDDS)'
            ],
            pageSize: 5
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(
            `Ошибка USDA API: ${response.status}\n${error}`
        );
    }

    const data = await response.json();

    console.log('\nНайдено результатов:', data.totalHits);

    if (!data.foods || data.foods.length === 0) {
        console.log('Ничего не найдено.');
        return;
    }

    console.log('\nРезультаты поиска:\n');

    for (const food of data.foods) {
        console.log({
            id: food.fdcId,
            name: food.description,
            category: food.foodCategory,
            type: food.dataType
        });
    }
}

async function main() {
    if (!API_KEY) {
        throw new Error('Не найден USDA_API_KEY в файле .env');
    }

    await searchFood('bell pepper raw');
}

main().catch(error => {
    console.error('\nОшибка:', error.message);
});
