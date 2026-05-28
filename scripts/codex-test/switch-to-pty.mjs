// One-shot: switch CodexTest's runtime to codex-pty.
import db from 'better-sqlite3';
const conn = db('C:/Users/ssdlh/Desktop/teammcp/data/teammcp.db');
console.log('before:', conn.prepare("SELECT name, runtime, status FROM agents WHERE name='CodexTest'").get());
conn.prepare("UPDATE agents SET runtime='codex-pty', status='offline' WHERE name='CodexTest'").run();
console.log('after :', conn.prepare("SELECT name, runtime, status FROM agents WHERE name='CodexTest'").get());
