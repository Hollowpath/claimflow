/** Browser navigation behind a seam, so tests can observe it. */
export const navigation = {
  assign: (url: string): void => window.location.assign(url),
};
