import db from 'better-sqlite3';
const conn = db('C:/Users/ssdlh/Desktop/teammcp/data/teammcp.db');
conn.prepare("UPDATE agents SET status='offline' WHERE name='CodexTest'").run();
console.log(conn.prepare("SELECT name, runtime, status FROM agents WHERE name='CodexTest'").get());
