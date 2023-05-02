import ApiClient from '.';

export default function startExport(selected) {
  return ApiClient.fetcher({ path: `/exports?survey=${encodeURIComponent(selected)}` })
    .then(async (res) => {
      if (res.status !== 200) {
        throw new Error(`Error starting export: ${selected} Error: ${res.statusText}`);
      }

      return res.body.status;
    })
    .catch((err) => {
      console.error(err); // eslint-disable-line no-console
    });
}
