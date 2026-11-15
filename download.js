
const sharp = require('sharp');
const fs = require('fs');
const { downloadImage } = require('./imageDownloader');

async function downloadMenu() {
    const sourceUrl = process.argv[2];

    if (!sourceUrl) {
        throw new Error('Передайте ссылку на изображение меню: node download.js <URL>');
    }

    console.log('Загружаем меню...');

    const { buffer } = await downloadImage(sourceUrl);

    const metadata = await sharp(buffer).metadata();

    console.log('Получено изображение:');
    console.log(`Ширина: ${metadata.width}`);
    console.log(`Высота: ${metadata.height}`);
    console.log(`Формат: ${metadata.format}`);

    fs.writeFileSync('menu.jpg', buffer);

    console.log('Файл сохранён: menu.jpg');
}

downloadMenu().catch(error => {
    console.error('Ошибка загрузки:', error.message);
    process.exitCode = 1;
});
