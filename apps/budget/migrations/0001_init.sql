-- 日ごと・製品ごとの利用額。請求期間をまたぐ集計をしないよう、どの期間の分かを行に持つ
CREATE TABLE usage (
	period_start TEXT NOT NULL,
	charge_date TEXT NOT NULL,
	service_name TEXT NOT NULL,
	service_family TEXT NOT NULL,
	cost REAL NOT NULL,
	quantity REAL,
	unit TEXT,
	PRIMARY KEY (period_start, charge_date, service_name)
);

-- 期間ごとに一度だけ知らせるための記録。kind は actual:<percent> か forecast:100
CREATE TABLE notified (
	period_start TEXT NOT NULL,
	kind TEXT NOT NULL,
	notified_at TEXT NOT NULL,
	PRIMARY KEY (period_start, kind)
);

CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
