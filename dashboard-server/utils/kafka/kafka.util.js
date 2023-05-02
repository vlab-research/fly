const { Kafka, Partitioners } = require('kafkajs');
const Config = require('../../config').KAFKA;

const Conn = new Kafka({
  clientId: 'dashboard-server',
  brokers: Config.BROKERS,
  enforceRequestTimeout: true,
  acks: -1,
  connectionTimeout: 2000,
})

module.exports = { Conn, Partitioners, Config }
