import React from 'react';
import { Layout, Card, Row, Col } from 'antd';
import PropTypes from 'prop-types';
import TopQuestionsChart from '../TopQuestionsReport/TopQuestionsReport';
import StartTimeReport from '../StartTimeReport/StartTimeReport';
import JoinTimeReport from '../JoinTimeReport/JoinTimeReport';
import DurationReport from '../DurationReport/DurationReport';
import AnswersReport from '../AnswersReport/AnswersReport';
import './Surveys.css';

const { Content } = Layout;

const SurveyAnalysis = ({ formid, cubejs }) => {
  // Convert single formid to array for components that expect formids
  const formids = [formid];

  return (
    <Content style={{ padding: '24px' }}>
      <h2>Survey Analysis Dashboard</h2>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card title="Top Questions">
            <TopQuestionsChart formid={formid} cubejs={cubejs} />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Start Time Analysis">
            <StartTimeReport formids={formids} cubejs={cubejs} />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Join Time Analysis">
            <JoinTimeReport formids={formids} cubejs={cubejs} />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Duration Analysis">
            <DurationReport formids={formids} cubejs={cubejs} />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="Answers Analysis">
            <AnswersReport formids={formids} cubejs={cubejs} />
          </Card>
        </Col>
      </Row>
    </Content>
  );
};

SurveyAnalysis.propTypes = {
  formid: PropTypes.string.isRequired,
  cubejs: PropTypes.objectOf(PropTypes.any).isRequired,
};

export default SurveyAnalysis; 