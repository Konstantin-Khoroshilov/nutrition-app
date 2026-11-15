
const fs = require('fs');
const sharp = require('sharp');

const URL = 'https://freshvote.ru/menu/000000009.jpg';

async function downloadMenu() {
    console.log('Загружаем меню...');

    const response = await fetch(URL, {
        cache: 'no-store',
        headers: {
            'Cache-Control': 'no-cache'
        }
    });

    if (!response.ok) {
        throw new Error(`Ошибка загрузки: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const metadata = await sharp(buffer).metadata();

    console.log('Получено изображение:');
    console.log(`Ширина: ${metadata.width}`);
    console.log(`Высота: ${metadata.height}`);
    console.log(`Формат: ${metadata.format}`);

    fs.writeFileSync('menu.jpg', buffer);

    console.log('Файл сохранён: menu.jpg');
}

downloadMenu().catch(console.error);
