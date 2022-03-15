<script>
    import {
        filterFieldTypes,
        getQuestionFields,
    } from "..form/../../lib/typewheels/form.js";

    export let form, field;

    let index;

    const fields = getQuestionFields(form);

    const getIndex = (fields) => {
        const idx = fields.map(({ ref }) => ref).indexOf(field.ref);
        return idx;
    };

    $: {
        field = field;
        index = getIndex(fields);
    }
</script>

<div aria-live="assertive">
    <h1 class="text-xs sm:text-sm font-medium text-blue-500">
        Question
        {index + 1}
        out of
        {filterFieldTypes(form).length}
    </h1>
</div>
