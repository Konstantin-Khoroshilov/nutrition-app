
require('dotenv').config();

const fs = require('fs');
const sharp = require('sharp');

const INPUT_FILE = 'menu.jpg';
const OUTPUT_FILE = 'menu.json';

const CHUNK_HEIGHT = 1800;
const OVERLAP = 120;

// Создаём клиент Gemini
let ai;
let MODEL;

// Определяем нижнюю границу содержимого
async function findContentBottom(buffer) {
    const { data, info } = await sharp(buffer)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    for (let y = info.height - 1; y >= 0; y--) {
        let contentPixels = 0;

        for (let x = 0; x < info.width; x++) {
            const i = (y * info.width + x) * info.channels;

            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // Считаем пиксель частью содержимого,
            // если он отличается от белого фона
            if (r < 245 || g < 245 || b < 245) {
                contentPixels++;
            }
        }

        if (contentPixels > 3) {
            return y + 1;
        }
    }

    return info.height;
}

// Формируем инструкцию для Gemini
function createPrompt(chunkNumber, totalChunks) {
    return `
Ты специалист по распознаванию таблиц с меню кафе.

Перед тобой фрагмент большого изображения меню.

Номер фрагмента: ${chunkNumber} из ${totalChunks}.

Твоя задача — извлечь все блюда, представленные на изображении.

Для каждого блюда необходимо определить:

1. name — название блюда.
2. portion_weight_g — вес порции в граммах.
3. calories_per_100g — калорийность на 100 граммов.
4. protein_per_100g — белки на 100 граммов.
5. fat_per_100g — жиры на 100 граммов.
6. carbs_per_100g — углеводы на 100 граммов.

Правила распознавания:

- Сохраняй оригинальное название блюда.
- Не путай вес порции с показателями на 100 граммов.
- Не придумывай отсутствующие значения.
- Если значение невозможно прочитать, используй null.
- Не добавляй заголовки разделов как блюда.
- Не пропускай блюда, даже если часть строки плохо читается.
- Не округляй распознанные значения самостоятельно.
- Если на изображении есть повторяющиеся строки, извлекай их.
- Не включай рекламные надписи и описания кафе.
- Извлекай только блюда, которые действительно видны.

Верни исключительно JSON следующего формата:

{
  "dishes": [
    {
      "name": "Название блюда",
      "portion_weight_g": 200,
      "calories_per_100g": 150,
      "protein_per_100g": 10,
      "fat_per_100g": 5,
      "carbs_per_100g": 15
    }
  ]
}

Все числовые поля могут иметь значение null.
Не добавляй Markdown и пояснения.
ВАЖНО: если вес порции указан через косую черту,
например 200/10 или 90/25, используй ТОЛЬКО первое число:
200/10 = 200 г;
90/25 = 90 г.

Не складывай числа и не объединяй их.
В portion_weight_g записывай только число слева от косой черты.
`;
}

// Проверяем структуру ответа


function normalizeNumber(value, fieldName, dishName) {
    if (
        value === null ||
        value === undefined ||
        value === ''
    ) {
        return null;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) {
            console.warn(`Некорректное значение ${fieldName}`);
            return null;
        }

        return value;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().replace(',', '.');

        // Обработка нестандартной записи веса: 200/10, 90/25
        if (
            fieldName === 'portion_weight_g' &&
            /^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(normalized)
        ) {
            const weight = Number(normalized.split('/')[0]);

            console.log(
                `Вес "${dishName}": ${value} -> ${weight} г`
            );

            return weight;
        }

        // Обычные значения: 200, 200 г, 200 гр
        const match = normalized.match(
            /^(\d+(?:\.\d+)?)\s*(?:г|гр|g)?$/i
        );

        if (match) {
            return Number(match[1]);
        }
    }

    console.warn(
        `Не удалось распознать ${fieldName} у блюда "${dishName}".`,
        'Полученное значение:',
        value
    );

    return null;
}


function validateDish(dish, index) {
    if (!dish || typeof dish !== 'object') {
        throw new Error(`Некорректное блюдо №${index + 1}`);
    }

    if (
        typeof dish.name !== 'string' ||
        !dish.name.trim()
    ) {
        throw new Error(
            `Отсутствует название блюда №${index + 1}`
        );
    }

    return {
        name: dish.name.trim(),

        portion_weight_g: normalizeNumber(
            dish.portion_weight_g,
            'portion_weight_g',
            dish.name
        ),

        calories_per_100g: normalizeNumber(
            dish.calories_per_100g,
            'calories_per_100g',
            dish.name
        ),

        protein_per_100g: normalizeNumber(
            dish.protein_per_100g,
            'protein_per_100g',
            dish.name
        ),

        fat_per_100g: normalizeNumber(
            dish.fat_per_100g,
            'fat_per_100g',
            dish.name
        ),

        carbs_per_100g: normalizeNumber(
            dish.carbs_per_100g,
            'carbs_per_100g',
            dish.name
        )
    };
}

function saveProgress(dishes) {
    const result = {
        source: 'Freshvote',
        recognized_at: new Date().toISOString(),
        total_dishes: dishes.length,
        dishes
    };

    fs.writeFileSync(
        'menu.partial.json',
        JSON.stringify(result, null, 2),
        'utf8'
    );

    console.log(
        `Промежуточно сохранено блюд: ${dishes.length}`
    );
}

// Убираем дубликаты, возникшие из-за перекрытия фрагментов
function removeDuplicates(dishes) {
    const unique = new Map();

    for (const dish of dishes) {
        const fingerprint = JSON.stringify([
            dish.name.toLowerCase().replace(/\s+/g, ' ').trim(),
            dish.portion_weight_g,
            dish.calories_per_100g,
            dish.protein_per_100g,
            dish.fat_per_100g,
            dish.carbs_per_100g
        ]);

        if (!unique.has(fingerprint)) {
            unique.set(fingerprint, dish);
        }
    }

    return [...unique.values()];
}

// Распознаём один фрагмент
async function recognizeFragment(buffer, chunkNumber, totalChunks) {
    console.log(`Распознаём фрагмент ${chunkNumber}/${totalChunks}...`);

    // Увеличиваем ширину изображения для удобства
    // визуального анализа моделью.
    // Новых деталей это не добавляет.
    const preparedImage = await sharp(buffer)
        .resize({
            width: 1586,
            withoutEnlargement: false
        })
        .jpeg({ quality: 95 })
        .toBuffer();

    const base64 = preparedImage.toString('base64');

    const response = await ai.models.generateContent({
        model: MODEL,

        contents: [
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64
                }
            },
            createPrompt(chunkNumber, totalChunks)
        ],

        config: {
            responseMimeType: 'application/json',
            temperature: 0
        }
    });

    const resultText = response.text;

    if (!resultText) {
        throw new Error(
            `Gemini вернул пустой ответ для фрагмента ${chunkNumber}`
        );
    }

    let result;

    try {
        result = JSON.parse(resultText);
    } catch (error) {
        console.error('Ответ Gemini:', resultText);
        throw new Error('Не удалось разобрать JSON от Gemini');
    }

    if (!result || !Array.isArray(result.dishes)) {
        throw new Error('Gemini вернул неправильную структуру JSON');
    }

    const validatedDishes = result.dishes.map(validateDish);

    console.log(`Найдено блюд: ${validatedDishes.length}`);

    return validatedDishes;
}

// Основная функция
async function recognizeMenu() {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error(
            'Не задан GEMINI_API_KEY в файле .env'
        );
    }

    // SDK загружаем динамически, чтобы сохранить
    // существующий CommonJS-формат проекта.
    const { GoogleGenAI } = await import('@google/genai');

    ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY
    });

    MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

    if (!fs.existsSync(INPUT_FILE)) {
        throw new Error(`Не найден файл ${INPUT_FILE}`);
    }

    console.log('Открываем изображение...');

    const original = fs.readFileSync(INPUT_FILE);

    const metadata = await sharp(original).metadata();

    console.log(
        `Исходное разрешение: ${metadata.width}x${metadata.height}`
    );

    const contentBottom = await findContentBottom(original);

    console.log(`Нижняя граница меню: ${contentBottom}`);

    // Сначала определяем количество фрагментов
    const stride = CHUNK_HEIGHT - OVERLAP;

    let totalChunks = 1;

    while (
        (totalChunks - 1) * stride + CHUNK_HEIGHT <
        contentBottom - OVERLAP
    ) {
        totalChunks++;
    }

    console.log(`Всего фрагментов: ${totalChunks}`);

    const allDishes = [];

    let start = 0;
    let chunkNumber = 1;

    while (start < contentBottom) {
        const height = Math.min(
            CHUNK_HEIGHT,
            contentBottom - start
        );

        const fragment = await sharp(original)
            .extract({
                left: 0,
                top: start,
                width: metadata.width,
                height
            })
            .jpeg({ quality: 95 })
            .toBuffer();

        const dishes = await recognizeFragment(
            fragment,
            chunkNumber,
            totalChunks
        );

        allDishes.push(...dishes);

        const uniqueDishes = removeDuplicates(allDishes);

        saveProgress(uniqueDishes);

        const remaining = contentBottom - (start + height);

        // Если осталась только область перекрытия,
        // дополнительный запрос не нужен.
        if (remaining <= OVERLAP) {
            break;
        }

        start += stride;
        chunkNumber++;
    }

    const uniqueDishes = removeDuplicates(allDishes);

    const result = {
        source: 'Freshvote',
        source_image: INPUT_FILE,
        recognized_at: new Date().toISOString(),
        model: MODEL,
        total_dishes: uniqueDishes.length,
        dishes: uniqueDishes
    };

    // Сначала записываем временный файл.
    // Основной JSON не будет повреждён при ошибке записи.
    const tempFile = `${OUTPUT_FILE}.tmp`;

    fs.writeFileSync(
        tempFile,
        JSON.stringify(result, null, 2),
        'utf8'
    );

    fs.renameSync(tempFile, OUTPUT_FILE);

    console.log('----------------------------');
    console.log(`Распознано блюд: ${uniqueDishes.length}`);
    console.log(`Результат сохранён: ${OUTPUT_FILE}`);
}

// Запуск
recognizeMenu().catch(error => {
    console.error('Ошибка распознавания:', error);
    process.exitCode = 1;
});
