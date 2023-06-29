import ApiClient from '.';

export default function startExport(selected, body) {
  return ApiClient.fetcher({ method: 'POST', path: `/exports?survey=${encodeURIComponent(selected)}`, body })
    .then(async (res) => {
      if (res.status !== 201) {
        throw new Error(`Error starting export: ${selected} Error: ${res.statusText}`);
      }

      return res.body.status;
    })
    .catch((err) => {
      console.error(err); // eslint-disable-line no-console
    });
} 
