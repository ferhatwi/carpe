/**
 * Creates a FIFO async task queue to serialize asynchronous operations sequentially.
 */
export function createTaskQueue(): <T>(task: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve()

    return <T>(task: () => Promise<T>): Promise<T> => {
        const next = tail.then(task, task)
        tail = next.catch(() => {})
        return next
    }
}
