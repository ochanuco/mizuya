/** 同じ key の仕事を到着順に 1 つずつ流す。別の key は並べて走らせる。 */
export const createKeyedQueue = () => {
	const tails = new Map<string, Promise<void>>();
	return {
		run: (key: string, task: () => Promise<void>): Promise<void> => {
			const prev = tails.get(key) ?? Promise.resolve();
			const next = prev.then(task, task).catch(() => {});
			tails.set(key, next);
			void next.then(() => {
				if (tails.get(key) === next) tails.delete(key);
			});
			return next;
		},
		size: () => tails.size,
	};
};
