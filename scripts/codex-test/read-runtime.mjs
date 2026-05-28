import db from 'better-sqlite3';
const conn = db('C:/Users/ssdlh/Desktop/teammcp/data/teammcp.db');
const name = process.argv[2] || 'DashboardRuntimeTest';
console.log(conn.prepare("SELECT name, runtime, role, status FROM agents WHERE name = ?").get(name));
