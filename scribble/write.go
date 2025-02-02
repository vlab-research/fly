package main

import (
	"log"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/go-playground/validator/v10"
)

type Writeable interface {
	GetRow() []interface{}
}

func BatchValues(data []Writeable) []interface{} {
	values := []interface{}{}
	for _, d := range data {
		for _, r := range d.GetRow() {
			values = append(values, r)
		}
	}

	return values
}

func Prep(fn func(*kafka.Message) (Writeable, error), messages []*kafka.Message) ([]Writeable, error) {
	data := []Writeable{}
	for _, msg := range messages {
		w, err := fn(msg)

		if err != nil {
			// NOTE: will throw at any marhaling problem. Good for now!
			// maybe change this to keep writing and ignore the corrupted data?
			return nil, err

		}
		data = append(data, w)
	}

	return data, nil
}

func Write(v *validator.Validate, scribbler Scribbler, messages []*kafka.Message, strictMode bool) error {
	data, err := Prep(scribbler.Marshal, messages)
	if err != nil {
		return err
	}

	validData := []Writeable{}
	for _, d := range data {
		err := v.Struct(d)
		if err != nil {
			if strictMode {
				return err
			}
			// Log validation error but continue processing
			log.Printf("Validation error for record: %v", err)
			continue
		}
		validData = append(validData, d)
	}

	if len(validData) == 0 {
		return nil
	}

	return scribbler.SendBatch(validData)
}

type Writer struct {
	validate   *validator.Validate
	scribbler  Scribbler
	strictMode bool
}

type Scribbler interface {
	SendBatch([]Writeable) error
	Marshal(*kafka.Message) (Writeable, error)
}

func (w *Writer) Write(messages []*kafka.Message) error {
	return Write(w.validate, w.scribbler, messages, w.strictMode)
}

func GetWriter(scribbler Scribbler, config *Config) *Writer {
	validate := validator.New()
	return &Writer{
		validate:   validate,
		scribbler:  scribbler,
		strictMode: config.StrictMode,
	}
}
