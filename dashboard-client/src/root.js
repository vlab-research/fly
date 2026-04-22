import React from 'react';

import { Router, Route } from 'react-router-dom';
import { Layout } from 'antd';
import {
  App, LoginScreen, Surveys, ApiKeys, CreateExport, CreateChatLogExport, CreateFullMessagesExport,
} from './containers';
import {
  BailSystems, BailForm, BailEvents, BailEventDetail,
} from './containers/BailSystems';
import { PrivateRoute, Spinner } from './components';
import { TypeformCreateAuth } from './components/TypeformCreate/TypeformCreate';
import { Auth, History } from './services';
import FacebookPages from './containers/FacebookPages';
import Reloadly from './containers/Reloadly';
import Secrets from './containers/Secrets';
import Media from './containers/Media';
import MessageTemplates, { NewMessageTemplate, TemplateDetail } from './containers/MessageTemplates';

const handleAuthentication = ({ location }) => {
  if (/access_token|id_token|error/.test(location.hash)) {
    Auth.handleAuthentication();
  }
};

const NotFound = () => (
  <div style={{ width: 800, margin: '5em auto' }}> Page Not Found (maybe not yet built??) </div>
);

const Root = () => (
  <Layout style={{ minHeight: '100vh' }}>
    <Router history={History}>
      <PrivateRoute exact path="/" component={App} auth={Auth} />
      <PrivateRoute exact path="/surveys/auth" component={TypeformCreateAuth} auth={Auth} />
      <PrivateRoute exact path="/connect/facebook-messenger" component={FacebookPages} auth={Auth} />
      <PrivateRoute exact path="/connect/facebook-ads" component={NotFound} auth={Auth} />
      <PrivateRoute exact path="/connect/reloadly" component={Reloadly} auth={Auth} />
      <PrivateRoute exact path="/connect/secrets" component={Secrets} auth={Auth} />
      <PrivateRoute exact path="/connect/api-keys" component={ApiKeys} auth={Auth} />
      <PrivateRoute path="/surveys/:survey?" component={Surveys} auth={Auth} />
      <PrivateRoute exact path="/bails/:bailId/events/:eventId" component={BailEventDetail} auth={Auth} />
      <PrivateRoute exact path="/bails/:bailId/events" component={BailEvents} auth={Auth} />
      <PrivateRoute exact path="/bails/:bailId/edit" component={BailForm} auth={Auth} />
      <PrivateRoute exact path="/bails/create" component={BailForm} auth={Auth} />
      <PrivateRoute exact path="/bails" component={BailSystems} auth={Auth} />
      <PrivateRoute exact path="/media" component={Media} auth={Auth} />
      <PrivateRoute exact path="/message-templates" component={MessageTemplates} auth={Auth} />
      <PrivateRoute exact path="/message-templates/new" component={NewMessageTemplate} auth={Auth} />
      <PrivateRoute exact path="/message-templates/:id" component={TemplateDetail} auth={Auth} />
      <PrivateRoute exact path="/exports/create-full-messages" component={CreateFullMessagesExport} auth={Auth} />
      <PrivateRoute exact path="/exports/create-chat-log" component={CreateChatLogExport} auth={Auth} />
      <PrivateRoute exact path="/exports/create" component={CreateExport} auth={Auth} />
      <Route exact path="/login" render={props => <LoginScreen {...props} auth={Auth} />} />
      <Route
        path="/auth"
        render={(props) => {
          handleAuthentication(props);
          return <Spinner {...props} />;
        }}
      />
    </Router>
  </Layout>
);

export default Root;
