# Adrobot — управление кампаниями Keitaro

Тестовое приложение: **FastAPI + SQLAlchemy + Alembic** (backend) и **Next.js + TypeScript** (frontend).
Интерфейс доступен на русском языке. Данные кампаний, потоков и офферов читаются из Keitaro.

## Запуск на Windows (PowerShell)

Требуются Python 3.12 и Node.js >=20.9. Рекомендуется Node.js 22.

**Терминал 1 — backend** (команды из корня репозитория):

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r .\backend\requirements.txt
cd backend
Copy-Item .env.example .env  # только при первом запуске; не перезаписывайте заполненный .env
notepad .env
# Укажите KEITARO_BASE_URL и KEITARO_API_KEY. API-ключ не публикуйте.
alembic upgrade head
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

При повторном запуске достаточно активировать корневую `.venv`, перейти в `backend/` и запустить `uvicorn`.
Если `.env` уже существует, шаг `Copy-Item` пропустите.

**Терминал 2 — frontend** (из корня репозитория):

```powershell
cd frontend
npm ci
npm run dev
```

Откройте **http://localhost:3000**. Swagger backend: **http://127.0.0.1:8000/docs**.
Next.js проксирует запросы `/api/*` на FastAPI (см. `frontend/next.config.ts`).
Для другого адреса backend задайте `API_PROXY_TARGET` в `frontend/.env.local`, затем перезапустите Next.js.

## Проверки

```powershell
# В каталоге backend/, с активированной корневой .venv:
python -m pytest -q

# В каталоге frontend/:
npm run typecheck
npm test
npm run build
```

## Как пользоваться

1. В `backend/.env` задайте **KEITARO_BASE_URL** (адрес сервера Keitaro без `/admin`) и **KEITARO_API_KEY** (из профиля Keitaro).
2. В разделе **Создать кампанию** укажите название (для тестового используйте префикс `test_<фамилия>_`), GEO-коды, оффер, домен, группу и источник.
3. Проверьте схему из двух потоков и подтвердите создание. Это **реальная запись в Keitaro**.
4. В разделе **Редактор офферов** выберите кампанию и поток, отредактируйте доли и нажмите **Сохранить в Keitaro**. Изменения отправляются только после подтверждения.
5. После записи интерфейс повторно загружает данные из Keitaro для проверки.

**Важно:** используйте только разрешённые тестовые кампании. Не добавляйте `.env`, API-ключ, пароль Keitaro, `.venv`, `node_modules` или `.next` в Git.

Keitaro остаётся источником истины для кампаний и офферов. Выбранный домен передаётся в Keitaro через `domain_id` при создании кампании; SQLite/SQLAlchemy хранит локальную копию привязки для интерфейса и журнал операций. Для подробностей об API и миграциях см. [backend/README.md](backend/README.md).

В комплекте также остался исходный HTML-интерфейс на `http://127.0.0.1:8000/` как справочный вариант. Основная русскоязычная панель — Next.js на порту 3000.
