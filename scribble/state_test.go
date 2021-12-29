package main

import (
	"context"
	"testing"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/stretchr/testify/assert"
	"github.com/vlab-research/spine"
)

func TestStateWriterWritesGoodData(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)

	msgs := makeMessages([]string{
		`{
		  "userid": "bar",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "current_state": "QOUT",
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
		`{
		  "userid": "baz",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "current_state": "RESPONDING",
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
	})

	writer := GetWriter(NewStateScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "states", "state_json->>'token'")
	assert.Equal(t, len(res), 2)

	assert.Equal(t, "bar", *res[0])
	assert.Equal(t, "bar", *res[1])
}

func TestStateWriterOverwritesOnePersonsState(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)

	msgs := makeMessages([]string{
		`{
		  "userid": "bar",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "current_state": "QOUT",
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
		`{
		  "userid": "bar",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "current_state": "RESPONDING",
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
	})

	writer := GetWriter(NewStateScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	res := getCol(pool, "states", "current_state")
	assert.Equal(t, len(res), 1)

	assert.Equal(t, "RESPONDING", *res[0])
}

func TestStateWriterOverwritesOnePersonsStateIgnoresUpdatedTimeOverwritesWithLatest(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)

	msgs := makeMessages([]string{
		`{
		  "userid": "bar",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "current_state": "QOUT",
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
		`{
		  "userid": "bar",
		  "pageid": "foo",
		  "updated": 1598706035000,
		  "current_state": "RESPONDING",
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
	})

	writer := GetWriter(NewStateScribbler(pool))
	err := writer.Write(msgs)
	assert.Nil(t, err)

	rows, err := pool.Query(context.Background(), "SELECT updated FROM states")
	assert.Nil(t, err)

	for rows.Next() {
		col := new(time.Time)
		err = rows.Scan(&col)
		assert.Nil(t, err)
		assert.Equal(t, int64(1598706035), col.Unix())
	}
}

func TestStateWriterFailsOnBadDataInOneRecordValidationHandler(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)

	msgs := makeMessages([]string{
		`{
		  "userid": "bar",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
		`{
		  "userid": "baz",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "current_state": "RESPONDING",
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
	})

	writer := GetWriter(NewStateScribbler(pool))
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	handled, _ := ValidationHandler(err)
	assert.True(t, handled)

	if e, ok := err.(validator.ValidationErrors); ok {
		t.Log(e)
	}

	res := getCol(pool, "states", "state_json->>'token'")
	assert.Equal(t, len(res), 0)
}

func TestStateWriterFailsOnMissingState(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)

	msgs := makeMessages([]string{
		`{
		  "userid": "baz",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "current_state": "RESPONDING",
		  "state_json": {}
		}`,
	})

	writer := GetWriter(NewStateScribbler(pool))
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	handled, _ := CheckConstraintHandler(err)
	assert.True(t, handled)

	res := getCol(pool, "states", "state_json->>'token'")
	assert.Equal(t, len(res), 0)
}

func TestStateWriterFailsStateViolatesFacebookPageConstraintHandledByForeignKeyHandler(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	msgs := makeMessages([]string{
		`{
		  "userid": "baz",
		  "pageid": "notapage",
		  "updated": 1598706047838,
		  "current_state": "RESPONDING",
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
	})

	writer := GetWriter(NewStateScribbler(pool))
	err := writer.Write(msgs)
	assert.NotNil(t, err)

	// TODO: this isn't a unit test, testing foreignkeyhandlers too
	handled, _ := ForeignKeyHandler(err)
	assert.True(t, handled)

	res := getCol(pool, "states", "state_json->>'token'")
	assert.Equal(t, len(res), 0)
}

func TestStateWriterWithHandlersIntegration(t *testing.T) {
	before()

	cfg := getConfig()
	pool := getPool(cfg)
	defer pool.Close()

	mustExec(t, pool, insertUser)
	mustExec(t, pool, insertCredentials)

	msgs := makeMessages([]string{
		`{
		  "userid": "bar",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "state_json": {
		    "token": "bar",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
		`{
		  "userid": "baz",
		  "pageid": "foo",
		  "updated": 1598706047838,
		  "current_state": "RESPONDING",
		  "state_json": {
		    "token": "baz",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
		`{
		  "userid": "baz",
		  "pageid": "notapage",
		  "updated": 1598706047838,
		  "current_state": "RESPONDING",
		  "state_json": {
		    "token": "qux",
		    "state": "QOUT",
		    "tokens": [
		      "foo"
		    ]
		  }
		}`,
	})

	writer := GetWriter(NewStateScribbler(pool))
	c := &spine.TestConsumer{Messages: msgs, Commits: 0}
	consumer := spine.KafkaConsumer{c, time.Second, 3, 1}

	errs := make(chan error)
	mainErrors := HandleErrors(errs, getHandlers(&Config{Handlers: "validation,foreignkey"}))
	go func() {
		for e := range mainErrors {
			t.Errorf("Should not have any errors, had error: %v", e)
		}
	}()

	consumer.SideEffect(writer.Write, errs)
	res := getCol(pool, "states", "state_json->>'token'")
	assert.Equal(t, 1, len(res))
}
