import React from 'react';
import PropTypes from 'prop-types';
import {
  Switch, Route, useRouteMatch, useLocation, useHistory, Link, Redirect
} from 'react-router-dom';
import { Table, Spin, Tabs } from 'antd';
import './SurveyScreen.css';
import { FormScreen, StatesSummary, StatesList, StateDetail } from '..';
import { groupBy } from '../../helpers';
import { CreateBtn } from '../../components/UI';

const { TabPane } = Tabs;

const Survey = ({ forms, selected }) => {
  const nameLookup = Object.fromEntries(forms.map(f => [f.id, f.prettyName]));

  const match = useRouteMatch();
  const getTranslationInfo = (record) => {
    if (record.translation_conf.self) {
      return 'self';
    }
    const dest = record.translation_conf.destination;
    if (dest && nameLookup[dest]) {
      return nameLookup[dest];
    }

    return null;
  };

  const grouped = groupBy(forms, f => f.shortcode);
  const data = [...grouped].map(([__, forms]) => forms[0]);
  const metadataFields = forms
    .map(f => f.metadata)
    .filter(md => md)
    .reduce((a, b) => [...a, ...Object.keys(b).filter(k => !a.includes(k))], []);

  let columns = ['shortcode', 'version', 'created', ...metadataFields]
    .map(f => ({ title: f, dataIndex: f, sorter: { compare: (a, b) => (a[f] > b[f] ? 1 : -1) } }));

  const ShortCodeLink = (text, record) => (
    <Link to={`${match.url}/form/${record.id}`}>
      {' '}
      {text}
      {' '}
    </Link>
  );

  columns[0] = {
    ...columns[0],
    render: ShortCodeLink,
  };

  columns[2] = {
    ...columns[2],
    render: text => (`${text.toLocaleDateString()} - ${text.toLocaleTimeString()}`),
  };

  const ActionLink = (text, record) => (<Link to={`/surveys/create?from=${record.id}`}> new version </Link>);

  columns = [...columns,
  { title: 'translation', dataIndex: 'translation_conf', render: (text, record) => getTranslationInfo(record) },
  { title: 'actions', dataIndex: 'id', render: ActionLink },
  { title: 'killed', dataIndex: 'off_time', render: text => text && (<span className="skull">☠☠☠</span>) },
  ];

  const PrettyNameLink = (text, record) => (
    <Link to={`${match.url}/form/${record.id}`}>
      {record.prettyName}
    </Link >
  );

  const expandedRowRender = (row) => {
    const expanded = grouped.get(row.shortcode);
    const cols = [...columns];
    cols[0] = {
      title: 'form',
      dataIndex: 'prettyName',
      render: PrettyNameLink,
    };

    return (<Table columns={cols} dataSource={expanded} pagination={false} showHeader />);
  };


  return (
    <Spin spinning={false}>
      <div className="survey-table">
        <div className="buttons">
          <CreateBtn to={`/surveys/create?survey_name=${encodeURIComponent(selected)}`}> NEW FORM </CreateBtn>
        </div>
        <Table
          columns={columns}
          dataSource={data}
          pagination={{ pageSize: 20 }}
          expandable={{ expandedRowRender, indentSize: 100 }}
        />
      </div>
    </Spin>
  );
};

const ExportPanel = ({ selected }) => (
  <div style={{ padding: '24px 0' }}>
    <CreateBtn to={`/exports/create?survey_name=${encodeURIComponent(selected)}`}> EXPORT </CreateBtn>
  </div>
);

const MonitorSection = ({ surveyName, match }) => {
  const location = useLocation();
  const history = useHistory();

  const getActiveSubTab = () => {
    const path = location.pathname;
    if (path.endsWith('/list') || path.includes('/list?')) return 'list';
    // Detail pages (monitor/:userid) should highlight the "list" tab
    const monitorBase = `${match.url}/monitor`;
    const remainder = path.slice(monitorBase.length);
    if (remainder && remainder !== '/' && !remainder.startsWith('/list')) return 'list';
    return 'summary';
  };

  const handleSubTabChange = (key) => {
    if (key === 'summary') {
      history.push(`${match.url}/monitor`);
    } else {
      history.push(`${match.url}/monitor/list`);
    }
  };

  return (
    <div>
      <Tabs
        activeKey={getActiveSubTab()}
        onChange={handleSubTabChange}
        size="small"
        style={{ marginBottom: 16 }}
      >
        <TabPane tab="Summary" key="summary" />
        <TabPane tab="Respondents" key="list" />
      </Tabs>

      <Switch>
        <Route exact path={`${match.path}/monitor`}>
          <StatesSummary surveyName={surveyName} />
        </Route>
        <Route exact path={`${match.path}/monitor/list`}>
          <StatesList surveyName={surveyName} />
        </Route>
        <Route exact path={`${match.path}/monitor/:userid`}>
          <StateDetail surveyName={surveyName} backPath={`${match.url}/monitor/list`} />
        </Route>
      </Switch>
    </div>
  );
};

const SurveyScreen = ({ forms, selected }) => {
  const match = useRouteMatch();
  const location = useLocation();
  const history = useHistory();

  const getActiveTab = () => {
    const path = location.pathname.slice(match.url.length);
    if (path.startsWith('/monitor')) return 'monitor';
    if (path.startsWith('/export')) return 'export';
    return 'edit';
  };

  const handleTabChange = (key) => {
    history.push(`${match.url}/${key}`);
  };

  return (
    <div>
      <Tabs activeKey={getActiveTab()} onChange={handleTabChange}>
        <TabPane tab="Edit" key="edit" />
        <TabPane tab="Monitor" key="monitor" />
        <TabPane tab="Export" key="export" />
      </Tabs>

      <Switch>
        <Redirect exact from={match.path} to={`${match.url}/edit`} />

        <Route exact path={`${match.path}/edit`}>
          <Survey forms={forms} selected={selected} />
        </Route>
        <Route exact path={`${match.path}/edit/form/:surveyid`}>
          <FormScreen forms={forms} />
        </Route>

        <Route path={`${match.path}/monitor`}>
          <MonitorSection surveyName={selected} match={match} />
        </Route>

        <Route exact path={`${match.path}/export`}>
          <ExportPanel selected={selected} />
        </Route>
      </Switch>
    </div>
  );
};

Survey.propTypes = {
  forms: PropTypes.arrayOf(PropTypes.object).isRequired,
  selected: PropTypes.string.isRequired,
};

ExportPanel.propTypes = {
  selected: PropTypes.string.isRequired,
};

MonitorSection.propTypes = {
  surveyName: PropTypes.string.isRequired,
  match: PropTypes.object.isRequired,
};

SurveyScreen.propTypes = {
  forms: PropTypes.arrayOf(PropTypes.object).isRequired,
  selected: PropTypes.string.isRequired,
};

export default SurveyScreen;
