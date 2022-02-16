<script>
    import { filterFieldTypes } from "..form/../../lib/typewheels/form.js";
    export let index, form;
</script>

<div>
    <h2 class="text-xs font-medium text-blue-500">
        Question
        {index + 1}
        out of
        {filterFieldTypes(form).length}
    </h2>
</div>
