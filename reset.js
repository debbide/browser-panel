const db = require('better-sqlite3')('./data/app.db');
db.prepare("UPDATE tasks SET next_run_at = NULL WHERE schedule_mode = 'daily_window'").run();
console.log('Reset completed.');
