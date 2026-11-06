export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = Record<
	LogLevel,
	(msg: string, fields?: Record<string, unknown>) => void
>;

const order: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export const createLogger = (min: LogLevel): Logger => {
	const make =
		(level: LogLevel) => (msg: string, fields?: Record<string, unknown>) => {
			if (order[level] < order[min]) return;
			console.log(
				JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }),
			);
		};
	return {
		debug: make("debug"),
		info: make("info"),
		warn: make("warn"),
		error: make("error"),
	};
};

export const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};
