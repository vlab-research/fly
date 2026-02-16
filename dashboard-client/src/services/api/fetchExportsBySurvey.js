import ApiClient from '.';

export default function fetchExportsBySurvey(surveyName) {
  return ApiClient.fetcher({
    method: 'GET',
    path: `/exports/status/survey?survey=${encodeURIComponent(surveyName)}`,
  }).then(res => res.json());
}
