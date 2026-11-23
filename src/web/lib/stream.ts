/** AsyncIterable を ReadableStream にする（ReadableStream.from は DOM の型定義にないため）。 */
export const toReadableStream = <T>(
  iterable: AsyncIterable<T>,
): ReadableStream<T> => {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    pull: async (controller) => {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel: async (reason) => {
      await iterator.return?.(reason);
    },
  });
};

/**
 * 最初の要素が来るまで待ち、何も無ければ null を返す。
 * 生成中でないときの再接続（すぐ終わるストリーム）を見分けるのに使う。
 */
export const peekIterable = async <T>(
  iterable: AsyncIterable<T>,
): Promise<AsyncIterable<T> | null> => {
  const iterator = iterable[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    return null;
  }
  return {
    [Symbol.asyncIterator]: () => {
      let yieldedFirst = false;
      return {
        next: () => {
          if (!yieldedFirst) {
            yieldedFirst = true;
            return Promise.resolve(first);
          }
          return iterator.next();
        },
        return: (value?: unknown) =>
          iterator.return?.(value) ??
          Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
};
