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

<div aria-live="assertive" class="mb-4">
    <h1 class="text-xs md:text-sm font-medium text-blue-700">
        Question
        {index + 1}
        out of
        {filterFieldTypes(form).length}
    </h1>
</div>
