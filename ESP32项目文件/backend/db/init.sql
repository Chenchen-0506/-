-- 边净牧安后端 MySQL 建表脚本(上线切 MySQL 时执行)
-- 用法: mysql -u root -p < db/init.sql

CREATE DATABASE IF NOT EXISTS pig_monitor DEFAULT CHARACTER SET utf8mb4;
USE pig_monitor;

CREATE TABLE IF NOT EXISTS sensor_records (
  id       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  temp     DECIMAL(5,1),
  hum      DECIMAL(5,1),
  weight   DECIMAL(8,1),
  flow     DECIMAL(6,2),
  irtemp   DECIMAL(5,1),
  gas      INT,
  lux      INT,
  time     BIGINT,
  time_str VARCHAR(64),
  INDEX idx_time (time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
