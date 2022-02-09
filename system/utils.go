package main

import (
	"bytes"
	"fmt"
	"github.com/olekukonko/tablewriter"
	"reflect"
	"strings"
)

func formatRows(rows []Row) ([]string, [][]string) {
	header := []string{}
	fRows := [][]string{}

	for _, row := range rows {
		fRow := []string{}
		e := reflect.ValueOf(&row).Elem()

		for i := 0; i < e.NumField(); i++ {
			if len(fRows) == 0 {
				name := e.Type().Field(i).Name
				header = append(header, name)
			}

			int := e.Field(i)
			val := fmt.Sprintf("%v", int)
			fRow = append(fRow, val)
		}

		fRows = append(fRows, fRow)
	}

	return header, fRows
}

func prettifyTables(tables []Table) string {
	prettyT := []string{}
	for _, table := range tables {
		header, rows := formatRows(table.rows)

		buf := &bytes.Buffer{}
		t := tablewriter.NewWriter(buf)
		t.SetHeader(header)
		t.SetRowLine(true)
		t.AppendBulk(rows)
		t.Render()

		prettyT = append(prettyT, buf.String())
	}

	text := []string{}
	for i, table := range prettyT {
		name := fmt.Sprintf("Table: %s", tables[i].name)
		text = append(text, name)
		text = append(text, table)
	}

	return strings.Join(text[:], "\n")
}
